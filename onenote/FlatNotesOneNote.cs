// FlatNotes OneNote exporter.
//
// Reads the locally installed OneNote through its desktop COM interface and writes one
// intermediate JSON file per OneNote section into a staging folder. The FlatNotes renderer
// turns each of those files into one new FlatNotes notebook.
//
// Why a compiled binary rather than a script: CreateObject("OneNote.Application") succeeds
// from cscript on this machine but every call after it fails 0x8002801D
// TYPE_E_LIBNOTREGISTERED, because the typelib is registered Win32 only while Office is
// ClickToRun x64. Early binding against the Microsoft.Office.Interop.OneNote PIA in the GAC
// never touches the typelib, so it works. Build it with onenote\setup-onenote.ps1.
//
// Usage:
//   FlatNotesOneNote.exe list [--out <file.json>]
//   FlatNotesOneNote.exe export --out <dir> [--sections <id>[,<id>...]] [--max-pages <n>]
//
// Progress is written to stdout as plain ASCII lines so no console codepage can corrupt it:
//   P <pagesDone> <pagesTotal>          one per page fetched
//   S <sectionIndex> <sectionTotal> <fileName>   one per section written
//   ERR <message>                       a page that could not be fetched, import continues
//   DONE                                followed by the summary JSON on the next line
//
// ---------------------------------------------------------------------------------------
// JSON schema written per section (schema 1). Coordinates are already FlatNotes page units
// (1 unit = 1/96 inch, PAGE_W 820 x PAGE_H 1160), so the renderer only has to add ids and
// bboxes. Item points are flattened into one array of x,y,p triples to keep the file small.
//
// {
//   "schema": 1,
//   "notebook": "Uni",                     OneNote notebook name
//   "section": "Physics",                  OneNote section name
//   "name": "Uni / Physics",               the FlatNotes notebook name to create
//   "sectionId": "{...}{1}{...}",
//   "pages": [                             flat list of FlatNotes pages, in reading order
//     {
//       "title": "Lecture 2",              the OneNote page title, kept as the page name
//       "ocrText": "...",                  OneNote's own handwriting OCR, not drawn
//       "source": 3,                       index of the OneNote page this one came from
//       "slice": 0,                        always 0: pages are no longer cut into sheets
//       "items": [
//         { "t":"s", "tool":"pen", "color":"#1d1d1f", "size":2.1, "opacity":1,
//           "pts":[x,y,p, x,y,p, ...] },
//         { "t":"t", "x":10, "y":20, "text":"hello", "size":14.7, "color":"#1d1d1f" },
//         { "t":"i", "x":10, "y":20, "w":300, "h":200, "nw":600, "nh":400,
//           "src":"data:image/png;base64,..." }
//       ]
//     }
//   ],
//   "stats": { "onenotePages":12, "flatPages":19, "strokes":8123, "points":712000,
//              "texts":40, "images":6, "highlighterStrokes":12,
//              "skippedTables":2, "skippedImages":1, "skippedFiles":0, "skippedTags":3,
//              "skippedPrintouts":0, "oversizeItems":0, "pageFailures":0,
//              "minScale":0.44, "seconds":31.2 }
// }
// ---------------------------------------------------------------------------------------

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using System.Windows.Ink;
using System.Xml;
using Microsoft.Office.Interop.OneNote;

static class Exporter {

  const string NS = "http://schemas.microsoft.com/office/onenote/2013/onenote";

  // FlatNotes page geometry, mirrored from app/js/main.js.
  const double PAGE_W = 820.0;
  const double PAGE_H = 1160.0;
  const double MARGIN = 24.0;      // breathing room kept around the imported content

  // OneNote positions and sizes are in points (1/72 inch); FlatNotes units are 96 dpi
  // pixels. ISF stroke coordinates are already 96 dpi pixels and page global, so they
  // need no conversion at all.
  const double PT = 4.0 / 3.0;

  // A pen stroke is rendered by FlatNotes at size * pressureScale(p), roughly 0.59 of the
  // nominal size at the mid pressure most of this corpus carries, so carrying the ISF width
  // across untouched draws thinner than OneNote does. The gain below was measured, not
  // guessed: OneNote's own EMF render of a real page was rasterised at 4x and its ink
  // coverage divided by the stroke polyline length gives a mean drawn width of 0.675 units
  // against a nominal ISF width of 0.945, while FlatNotes at gain 1.0 would draw the same
  // strokes at 0.556. 0.675 / 0.556 is 1.21. The highlighter needs no gain: the renderer
  // draws it at flat width.
  const double PEN_WIDTH_GAIN = 1.2;

  // ISF is heavily oversampled: OneNote records points far closer together than a stroke
  // outline needs. The renderer already throws away anything within 0.35 units of the
  // previous kept point (Ink.cullPoints) before it builds a path, so culling to the same
  // threshold here is free visually and halves the point count, the file size, the
  // IndexedDB write and the time an import takes.
  const double CULL_DIST = 0.35;

  const double DEFAULT_FONT_PT = 11.0;
  const double TITLE_FONT_PT = 20.0;
  const double LINE_HEIGHT = 1.35;   // matches drawItem() in main.js
  const double AVG_ADVANCE = 0.5;    // rough mean glyph advance as a fraction of font size
  const string DEFAULT_TEXT_COLOR = "#1d1d1f";

  static Application app;

  /* ============================ small helpers ============================ */

  static string J(string s) {
    if (s == null) return "null";
    var sb = new StringBuilder(s.Length + 8);
    sb.Append('"');
    for (int i = 0; i < s.Length; i++) {
      char c = s[i];
      if (c == '"' || c == '\\') { sb.Append('\\'); sb.Append(c); }
      else if (c == '\n') sb.Append("\\n");
      else if (c == '\r') sb.Append("\\r");
      else if (c == '\t') sb.Append("\\t");
      else if (c < 32 || c == 0x7f) sb.Append("\\u").Append(((int)c).ToString("x4"));
      else sb.Append(c);
    }
    sb.Append('"');
    return sb.ToString();
  }

  static string N(double v) {
    if (double.IsNaN(v) || double.IsInfinity(v)) return "0";
    return Math.Round(v, 2).ToString("0.##", CultureInfo.InvariantCulture);
  }

  static double D(XmlNode n, string attr) {
    if (n == null || n.Attributes[attr] == null) return 0;
    double v;
    double.TryParse(n.Attributes[attr].Value, NumberStyles.Float, CultureInfo.InvariantCulture, out v);
    return v;
  }

  static string A(XmlNode n, string attr) {
    if (n == null || n.Attributes[attr] == null) return null;
    return n.Attributes[attr].Value;
  }

  static string Sanitize(string s) {
    if (string.IsNullOrEmpty(s)) return "";
    var sb = new StringBuilder(s.Length);
    foreach (char c in s) if (c >= 32 || c == '\n' || c == '\t') sb.Append(c);
    return sb.ToString().Trim();
  }

  /* ============================ item model ============================ */

  class Item {
    public string Kind;       // s | t | i
    public int Z;
    public int Order;         // document order, the tie break inside one z
    public double X, Y, W, H; // page global, FlatNotes units, before the uniform scale
    // stroke
    public List<double> Pts;  // x, y, p triples, page global
    public string Color;
    public double Size;
    public double Opacity;
    public bool Highlighter;
    // text
    public string Text;
    public double FontSize;
    // image
    public string Src;
    public int NW, NH;
  }

  class Stats {
    public int OnenotePages, FlatPages, Strokes, Texts, Images, Highlighters;
    public long Points;
    public int SkippedTables, SkippedImages, SkippedFiles, SkippedTags, SkippedPrintouts;
    public int Oversize, PageFailures;
    public double MinScale = 1.0;
  }

  /* ============================ COM plumbing ============================ */

  // COM throws 0x800706BF / 0x800706BE intermittently once a few dozen pages have been
  // pulled, so every fetch retries behind a fresh Application object.
  static string Fetch(string id) {
    for (int t = 0; t < 4; t++) {
      try {
        string x;
        app.GetPageContent(id, out x, PageInfo.piBinaryData);
        return x;
      } catch (Exception) {
        try { app = new Application(); } catch (Exception) { }
        System.Threading.Thread.Sleep(t == 0 ? 400 : 1500);
      }
    }
    return null;
  }

  static string Hierarchy() {
    for (int t = 0; t < 4; t++) {
      try {
        string x;
        app.GetHierarchy(null, HierarchyScope.hsPages, out x);
        return x;
      } catch (Exception) {
        try { app = new Application(); } catch (Exception) { }
        System.Threading.Thread.Sleep(1000);
      }
    }
    return null;
  }

  class SectionRef {
    public string Id, Name, Notebook;
    public List<string> PageIds = new List<string>();
    public List<string> PageNames = new List<string>();
  }

  static List<SectionRef> ReadSections() {
    string xml = Hierarchy();
    if (xml == null) throw new Exception("OneNote did not return its hierarchy");
    var doc = new XmlDocument();
    doc.LoadXml(xml);
    var ns = new XmlNamespaceManager(doc.NameTable);
    ns.AddNamespace("one", NS);
    var list = new List<SectionRef>();
    foreach (XmlNode sec in doc.SelectNodes("//one:Section", ns)) {
      if (A(sec, "isRecycleBin") == "true" || A(sec, "isInRecycleBin") == "true") continue;
      var s = new SectionRef();
      s.Id = A(sec, "ID");
      s.Name = A(sec, "name");
      if (s.Name == null) s.Name = "Section";
      XmlNode nb = sec.ParentNode;
      while (nb != null && nb.LocalName != "Notebook") nb = nb.ParentNode;
      s.Notebook = (nb != null && A(nb, "name") != null) ? A(nb, "name") : "OneNote";
      foreach (XmlNode pg in sec.SelectNodes("one:Page", ns)) {
        if (A(pg, "isInRecycleBin") == "true") continue;
        s.PageIds.Add(A(pg, "ID"));
        s.PageNames.Add(A(pg, "name") == null ? "" : A(pg, "name"));
      }
      if (s.PageIds.Count > 0) list.Add(s);
    }
    return list;
  }

  /* ============================ text handling ============================ */

  static readonly Regex TagRe = new Regex("<[^>]*>", RegexOptions.Compiled);
  static readonly Regex BrRe = new Regex("<br\\s*/?>", RegexOptions.Compiled | RegexOptions.IgnoreCase);
  static readonly Regex EntNum = new Regex("&#(x?)([0-9A-Fa-f]+);", RegexOptions.Compiled);
  static readonly Regex FontSizeRe = new Regex("font-size:\\s*([0-9.]+)pt", RegexOptions.Compiled | RegexOptions.IgnoreCase);
  static readonly Regex ColorRe = new Regex("color:\\s*(#[0-9A-Fa-f]{6}|[a-zA-Z]+)", RegexOptions.Compiled | RegexOptions.IgnoreCase);

  static string Decode(string s) {
    if (string.IsNullOrEmpty(s)) return "";
    s = BrRe.Replace(s, "\n");
    s = TagRe.Replace(s, "");
    s = EntNum.Replace(s, delegate(Match m) {
      try {
        int code = m.Groups[1].Value.Length > 0
          ? Convert.ToInt32(m.Groups[2].Value, 16)
          : int.Parse(m.Groups[2].Value, CultureInfo.InvariantCulture);
        return char.ConvertFromUtf32(code);
      } catch (Exception) { return ""; }
    });
    s = s.Replace("&nbsp;", " ").Replace("&quot;", "\"").Replace("&apos;", "'")
         .Replace("&lt;", "<").Replace("&gt;", ">").Replace("&amp;", "&");
    return s;
  }

  static readonly Dictionary<string, string> NAMED = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) {
    { "red", "#e0342b" }, { "blue", "#2563eb" }, { "green", "#159a51" }, { "black", "#1d1d1f" },
    { "yellow", "#eab308" }, { "orange", "#f0731d" }, { "purple", "#7c3aed" }, { "gray", "#64748b" },
    { "grey", "#64748b" }, { "white", "#ffffff" }, { "magenta", "#ec4899" }, { "cyan", "#0ea5a5" },
  };

  static string ColorFromStyle(string style) {
    if (string.IsNullOrEmpty(style)) return null;
    Match m = ColorRe.Match(style);
    if (!m.Success) return null;
    string v = m.Groups[1].Value;
    if (v.StartsWith("#")) return v.ToLowerInvariant();
    if (NAMED.ContainsKey(v)) return NAMED[v];
    return null;
  }

  static double FontFromStyle(string style) {
    if (string.IsNullOrEmpty(style)) return 0;
    Match m = FontSizeRe.Match(style);
    if (!m.Success) return 0;
    double v;
    double.TryParse(m.Groups[1].Value, NumberStyles.Float, CultureInfo.InvariantCulture, out v);
    return v;
  }

  static List<string> Wrap(string text, double maxWidth, double fontPx) {
    var outLines = new List<string>();
    double adv = Math.Max(1.0, fontPx * AVG_ADVANCE);
    int maxChars = Math.Max(10, (int)(maxWidth / adv));
    foreach (string para in text.Split('\n')) {
      string p = para.TrimEnd();
      if (p.Length == 0) { outLines.Add(""); continue; }
      if (p.Length <= maxChars) { outLines.Add(p); continue; }
      var words = p.Split(' ');
      var line = new StringBuilder();
      foreach (string w in words) {
        if (line.Length == 0) { line.Append(w); continue; }
        if (line.Length + 1 + w.Length <= maxChars) { line.Append(' ').Append(w); }
        else { outLines.Add(line.ToString()); line.Length = 0; line.Append(w); }
      }
      if (line.Length > 0) outLines.Add(line.ToString());
    }
    return outLines;
  }

  static Item MakeText(double x, double y, double width, string text, double fontPx, string color, int z, int order) {
    var lines = Wrap(text, width, fontPx);
    double w = 0;
    foreach (string l in lines) w = Math.Max(w, l.Length * fontPx * AVG_ADVANCE);
    var it = new Item();
    it.Kind = "t";
    it.X = x; it.Y = y;
    it.W = Math.Max(w, 8);
    it.H = Math.Max(1, lines.Count) * fontPx * LINE_HEIGHT;
    it.Text = string.Join("\n", lines.ToArray());
    it.FontSize = fontPx;
    it.Color = color;
    it.Z = z; it.Order = order;
    return it;
  }

  /* ============================ image handling ============================ */

  static string ImageMime(byte[] b) {
    if (b.Length < 12) return null;
    if (b[0] == 0x89 && b[1] == 0x50 && b[2] == 0x4E && b[3] == 0x47) return "image/png";
    if (b[0] == 0xFF && b[1] == 0xD8 && b[2] == 0xFF) return "image/jpeg";
    if (b[0] == 0x47 && b[1] == 0x49 && b[2] == 0x46) return "image/gif";
    if (b[0] == 0x42 && b[1] == 0x4D) return "image/bmp";
    return null; // EMF, WMF and anything else a browser cannot decode
  }

  // Natural pixel size straight from the container header, so the renderer never has to
  // decode 500 images just to learn their aspect ratio.
  static bool NaturalSize(byte[] b, string mime, out int w, out int h) {
    w = 0; h = 0;
    try {
      if (mime == "image/png" && b.Length > 24) {
        w = (b[16] << 24) | (b[17] << 16) | (b[18] << 8) | b[19];
        h = (b[20] << 24) | (b[21] << 16) | (b[22] << 8) | b[23];
        return w > 0 && h > 0;
      }
      if (mime == "image/gif" && b.Length > 10) {
        w = b[6] | (b[7] << 8); h = b[8] | (b[9] << 8);
        return w > 0 && h > 0;
      }
      if (mime == "image/bmp" && b.Length > 26) {
        w = b[18] | (b[19] << 8) | (b[20] << 16) | (b[21] << 24);
        h = Math.Abs(b[22] | (b[23] << 8) | (b[24] << 16) | (b[25] << 24));
        return w > 0 && h > 0;
      }
      if (mime == "image/jpeg") {
        int i = 2;
        while (i + 9 < b.Length) {
          if (b[i] != 0xFF) { i++; continue; }
          int marker = b[i + 1];
          if (marker == 0xD8 || marker == 0x01 || (marker >= 0xD0 && marker <= 0xD7)) { i += 2; continue; }
          int len = (b[i + 2] << 8) | b[i + 3];
          bool sof = (marker >= 0xC0 && marker <= 0xCF) && marker != 0xC4 && marker != 0xC8 && marker != 0xCC;
          if (sof) {
            h = (b[i + 5] << 8) | b[i + 6];
            w = (b[i + 7] << 8) | b[i + 8];
            return w > 0 && h > 0;
          }
          i += 2 + len;
        }
      }
    } catch (Exception) { }
    return false;
  }

  /* ============================ page parsing ============================ */

  static bool InsideTable(XmlNode n) {
    for (XmlNode p = n.ParentNode; p != null; p = p.ParentNode)
      if (p.LocalName == "Table") return true;
    return false;
  }

  static List<Item> ParsePage(XmlDocument doc, XmlNamespaceManager ns, Stats st,
                              out string title, out string ocrText) {
    var items = new List<Item>();
    int order = 0;

    XmlNode titleNode = doc.SelectSingleNode("//one:Title", ns);
    title = "";
    if (titleNode != null) {
      var parts = new List<string>();
      foreach (XmlNode t in titleNode.SelectNodes(".//one:T", ns)) parts.Add(Decode(t.InnerText));
      title = Sanitize(string.Join(" ", parts.ToArray()));
    }
    if (title.Length == 0) {
      XmlNode pageNode = doc.SelectSingleNode("//one:Page", ns);
      title = Sanitize(A(pageNode, "name"));
    }

    var ocr = new List<string>();
    foreach (XmlNode o in doc.SelectNodes("//one:OCRText", ns)) {
      string s = Sanitize(Decode(o.InnerText));
      if (s.Length > 0) ocr.Add(s);
    }
    ocrText = string.Join("\n", ocr.ToArray());

    st.SkippedTags += doc.SelectNodes("//one:Tag", ns).Count;
    st.SkippedTables += doc.SelectNodes("//one:Table", ns).Count;
    st.SkippedFiles += doc.SelectNodes("//one:InsertedFile", ns).Count
                     + doc.SelectNodes("//one:MediaFile", ns).Count;
    st.SkippedPrintouts += doc.SelectNodes("//one:Printout", ns).Count
                         + doc.SelectNodes("//one:XPSFile", ns).Count;

    // ---- ink ----
    foreach (XmlNode nd in doc.SelectNodes("//one:InkDrawing", ns)) {
      XmlNode data = nd.SelectSingleNode("one:Data", ns);
      if (data == null) continue;
      int z = (int)D(nd.SelectSingleNode("one:Position", ns), "z");
      StrokeCollection sc;
      try { sc = new StrokeCollection(new MemoryStream(Convert.FromBase64String(data.InnerText))); }
      catch (Exception) { continue; }
      foreach (Stroke s in sc) {
        int n = s.StylusPoints.Count;
        if (n == 0) continue;
        var pts = new List<double>(n * 3);
        double minx = double.MaxValue, miny = double.MaxValue, maxx = double.MinValue, maxy = double.MinValue;
        for (int i = 0; i < n; i++) {
          var sp = s.StylusPoints[i];
          double px = sp.X, py = sp.Y;
          double pr = sp.PressureFactor;
          if (pr <= 0 || pr > 1) pr = 0.5;
          pts.Add(px); pts.Add(py); pts.Add(pr);
          if (px < minx) minx = px;
          if (px > maxx) maxx = px;
          if (py < miny) miny = py;
          if (py > maxy) maxy = py;
        }
        var da = s.DrawingAttributes;
        // IsHighlighter is false on every stroke in this corpus. What actually marks a
        // highlighter stroke is an alpha below 255 in the stroke colour, and that alpha is
        // also the opacity OneNote drew it with.
        byte alpha = da.Color.A;
        bool hi = alpha < 255;
        // A highlighter carries a chisel tip: StylusTip Rectangle with Width 2.1 and
        // Height 15.1, which is OneNote's 4 mm highlighter. A pen is a round tip with
        // Width equal to Height, so the wider of the two is the drawn width either way.
        double width = Math.Max(da.Width, da.Height);
        if (width <= 0) width = 2.0;
        var it = new Item();
        it.Kind = "s";
        it.Pts = pts;
        it.Highlighter = hi;
        it.Opacity = hi ? Math.Round(alpha / 255.0, 3) : 1.0;
        it.Size = hi ? width : width * PEN_WIDTH_GAIN;
        it.Color = "#" + da.Color.R.ToString("x2") + da.Color.G.ToString("x2") + da.Color.B.ToString("x2");
        double pad = it.Size / 2.0;
        it.X = minx - pad; it.Y = miny - pad;
        it.W = (maxx - minx) + pad * 2; it.H = (maxy - miny) + pad * 2;
        it.Z = z; it.Order = order++;
        items.Add(it);
        st.Strokes++;
        st.Points += n;
        if (hi) st.Highlighters++;
      }
    }

    // ---- images ----
    foreach (XmlNode im in doc.SelectNodes("//one:Image", ns)) {
      XmlNode data = im.SelectSingleNode("one:Data", ns);
      XmlNode pos = im.SelectSingleNode("one:Position", ns);
      XmlNode size = im.SelectSingleNode("one:Size", ns);
      if (data == null || pos == null || size == null) { st.SkippedImages++; continue; }
      byte[] raw;
      try { raw = Convert.FromBase64String(data.InnerText); } catch (Exception) { st.SkippedImages++; continue; }
      string mime = ImageMime(raw);
      if (mime == null) { st.SkippedImages++; continue; }  // EMF and friends: no browser decoder
      int nw, nh;
      if (!NaturalSize(raw, mime, out nw, out nh)) { nw = 0; nh = 0; }
      var it = new Item();
      it.Kind = "i";
      it.X = D(pos, "x") * PT;
      it.Y = D(pos, "y") * PT;
      it.W = D(size, "width") * PT;
      it.H = D(size, "height") * PT;
      if (it.W <= 0 || it.H <= 0) {
        if (nw > 0 && nh > 0) { it.W = nw; it.H = nh; } else { st.SkippedImages++; continue; }
      }
      if (nw <= 0 || nh <= 0) { nw = (int)Math.Round(it.W); nh = (int)Math.Round(it.H); }
      it.NW = nw; it.NH = nh;
      it.Src = "data:" + mime + ";base64," + Convert.ToBase64String(raw);
      it.Z = (int)D(pos, "z");
      it.Order = order++;
      items.Add(it);
      st.Images++;
    }

    // ---- typed text ----
    foreach (XmlNode outline in doc.SelectNodes("//one:Outline", ns)) {
      XmlNode pos = outline.SelectSingleNode("one:Position", ns);
      XmlNode size = outline.SelectSingleNode("one:Size", ns);
      if (pos == null) continue;
      double ox = D(pos, "x") * PT;
      double oy = D(pos, "y") * PT;
      double ow = size != null ? D(size, "width") * PT : 260.0;
      if (ow < 60) ow = 260.0;
      int z = (int)D(pos, "z");
      double cursor = 0;
      foreach (XmlNode oe in outline.SelectNodes(".//one:OE", ns)) {
        if (InsideTable(oe)) continue;         // tables are a documented skip
        var parts = new List<string>();
        foreach (XmlNode t in oe.SelectNodes("one:T", ns)) parts.Add(Decode(t.InnerText));
        string text = Sanitize(string.Join("", parts.ToArray()));
        if (text.Length == 0) continue;
        string style = A(oe, "style");
        double fontPt = FontFromStyle(style);
        if (fontPt <= 0) fontPt = DEFAULT_FONT_PT;
        string color = ColorFromStyle(style);
        if (color == null) color = DEFAULT_TEXT_COLOR;
        // list bullets and numbers carry no glyph of their own once the markup is stripped
        if (oe.SelectSingleNode("one:List/one:Bullet", ns) != null) text = "- " + text;
        XmlNode num = oe.SelectSingleNode("one:List/one:Number", ns);
        if (num != null) {
          string t2 = A(num, "text");
          text = (t2 == null ? "1." : t2) + " " + text;
        }
        int depth = 0;
        for (XmlNode p = oe.ParentNode; p != null && p != outline; p = p.ParentNode)
          if (p.LocalName == "OEChildren") depth++;
        double indent = Math.Max(0, depth - 1) * 18.0;
        double fontPx = fontPt * PT;
        var it = MakeText(ox + indent, oy + cursor, Math.Max(80, ow - indent), text, fontPx, color, z, order++);
        cursor += it.H + fontPx * 0.35;
        items.Add(it);
        st.Texts++;
      }
    }

    return items;
  }

  /* ============================ layout ============================ */

  class Slice {
    public List<Item> Items = new List<Item>();
  }

  /** Same rule as Ink.cullPoints in the renderer: both ends kept, middles thinned. */
  static int Cull(List<double> p, double minDist) {
    int n = p.Count / 3;
    if (n < 3) return 0;
    var keep = new List<double>(p.Count);
    keep.Add(p[0]); keep.Add(p[1]); keep.Add(p[2]);
    double md2 = minDist * minDist, lx = p[0], ly = p[1];
    for (int i = 1; i < n - 1; i++) {
      double x = p[i * 3], y = p[i * 3 + 1];
      double dx = x - lx, dy = y - ly;
      if (dx * dx + dy * dy < md2) continue;
      keep.Add(x); keep.Add(y); keep.Add(p[i * 3 + 2]);
      lx = x; ly = y;
    }
    keep.Add(p[(n - 1) * 3]); keep.Add(p[(n - 1) * 3 + 1]); keep.Add(p[(n - 1) * 3 + 2]);
    int dropped = n - keep.Count / 3;
    p.Clear();
    p.AddRange(keep);
    return dropped;
  }

  // Uniform scale so an over-wide OneNote page fits PAGE_W (most pages come in at true
  // size). Nothing is cut vertically: a FlatNotes page grows to whatever height it needs, so
  // one OneNote page becomes exactly one page here, however long it is. Splitting it into
  // sheets is what made an imported notebook read badly.
  static List<Slice> Layout(List<Item> items, Stats st, out double scale) {
    scale = 1.0;
    var slices = new List<Slice>();
    if (items.Count == 0) { slices.Add(new Slice()); return slices; }

    double minX = double.MaxValue, minY = double.MaxValue, maxX = double.MinValue;
    foreach (Item it in items) {
      if (it.X < minX) minX = it.X;
      if (it.Y < minY) minY = it.Y;
      if (it.X + it.W > maxX) maxX = it.X + it.W;
    }
    double contentW = (maxX - minX) + MARGIN * 2;
    scale = Math.Min(1.0, PAGE_W / Math.Max(1.0, contentW));
    if (scale < st.MinScale) st.MinScale = scale;

    // move every item into scaled page space, top left of the content at (MARGIN, MARGIN)
    foreach (Item it in items) {
      double dx = MARGIN - minX * scale;
      double dy = MARGIN - minY * scale;
      it.X = it.X * scale + dx;
      it.Y = it.Y * scale + dy;
      it.W *= scale;
      it.H *= scale;
      if (it.Kind == "s") {
        it.Size *= scale;
        for (int i = 0; i < it.Pts.Count; i += 3) {
          it.Pts[i] = it.Pts[i] * scale + dx;
          it.Pts[i + 1] = it.Pts[i + 1] * scale + dy;
        }
        st.Points -= Cull(it.Pts, CULL_DIST);   // in final page units, so it matches the renderer
      } else if (it.Kind == "t") {
        it.FontSize *= scale;
      }
    }

    // paint order: OneNote's z rises from back to front, document order breaks ties
    items.Sort(delegate(Item a, Item b) {
      if (a.Z != b.Z) return a.Z.CompareTo(b.Z);
      return a.Order.CompareTo(b.Order);
    });

    var sl = new Slice();
    sl.Items.AddRange(items);   // already in paint order
    slices.Add(sl);
    return slices;
  }

  /* ============================ writing ============================ */

  static void WriteItem(TextWriter w, Item it) {
    if (it.Kind == "s") {
      w.Write("{\"t\":\"s\",\"tool\":");
      w.Write(it.Highlighter ? "\"highlighter\"" : "\"pen\"");
      w.Write(",\"color\":"); w.Write(J(it.Color));
      w.Write(",\"size\":"); w.Write(N(Math.Max(0.4, it.Size)));
      w.Write(",\"opacity\":"); w.Write(N(it.Opacity));
      w.Write(",\"pts\":[");
      for (int i = 0; i < it.Pts.Count; i++) {
        if (i > 0) w.Write(',');
        w.Write(i % 3 == 2
          ? Math.Round(it.Pts[i], 3).ToString("0.###", CultureInfo.InvariantCulture)
          : N(it.Pts[i]));
      }
      w.Write("]}");
    } else if (it.Kind == "t") {
      w.Write("{\"t\":\"t\",\"x\":"); w.Write(N(it.X));
      w.Write(",\"y\":"); w.Write(N(it.Y));
      w.Write(",\"size\":"); w.Write(N(Math.Max(6, it.FontSize)));
      w.Write(",\"color\":"); w.Write(J(it.Color));
      w.Write(",\"text\":"); w.Write(J(it.Text));
      w.Write("}");
    } else {
      w.Write("{\"t\":\"i\",\"x\":"); w.Write(N(it.X));
      w.Write(",\"y\":"); w.Write(N(it.Y));
      w.Write(",\"w\":"); w.Write(N(it.W));
      w.Write(",\"h\":"); w.Write(N(it.H));
      w.Write(",\"nw\":"); w.Write(it.NW.ToString(CultureInfo.InvariantCulture));
      w.Write(",\"nh\":"); w.Write(it.NH.ToString(CultureInfo.InvariantCulture));
      w.Write(",\"src\":"); w.Write(J(it.Src));
      w.Write("}");
    }
  }

  static void WriteStats(TextWriter w, Stats st, double seconds) {
    w.Write("{\"onenotePages\":" + st.OnenotePages);
    w.Write(",\"flatPages\":" + st.FlatPages);
    w.Write(",\"strokes\":" + st.Strokes);
    w.Write(",\"points\":" + st.Points);
    w.Write(",\"texts\":" + st.Texts);
    w.Write(",\"images\":" + st.Images);
    w.Write(",\"highlighterStrokes\":" + st.Highlighters);
    w.Write(",\"skippedTables\":" + st.SkippedTables);
    w.Write(",\"skippedImages\":" + st.SkippedImages);
    w.Write(",\"skippedFiles\":" + st.SkippedFiles);
    w.Write(",\"skippedTags\":" + st.SkippedTags);
    w.Write(",\"skippedPrintouts\":" + st.SkippedPrintouts);
    w.Write(",\"oversizeItems\":" + st.Oversize);
    w.Write(",\"pageFailures\":" + st.PageFailures);
    w.Write(",\"minScale\":" + N(st.MinScale));
    w.Write(",\"seconds\":" + N(seconds));
    w.Write("}");
  }

  static string SafeFile(string s, int index) {
    var sb = new StringBuilder();
    foreach (char c in s) {
      if (char.IsLetterOrDigit(c)) sb.Append(c);
      else if (sb.Length > 0 && sb[sb.Length - 1] != '-') sb.Append('-');
      if (sb.Length >= 40) break;
    }
    string body = sb.ToString().Trim('-');
    if (body.Length == 0) body = "section";
    return "s" + index.ToString("000") + "-" + body + ".json";
  }

  /* ============================ commands ============================ */

  static int CmdList(string outFile) {
    var sections = ReadSections();
    var sb = new StringBuilder();
    sb.Append("{\"schema\":1,\"sections\":[");
    for (int i = 0; i < sections.Count; i++) {
      if (i > 0) sb.Append(',');
      SectionRef s = sections[i];
      sb.Append("{\"id\":").Append(J(s.Id));
      sb.Append(",\"notebook\":").Append(J(s.Notebook));
      sb.Append(",\"section\":").Append(J(s.Name));
      sb.Append(",\"name\":").Append(J(s.Notebook + " / " + s.Name));
      sb.Append(",\"pageCount\":").Append(s.PageIds.Count);
      sb.Append('}');
    }
    sb.Append("]}");
    string json = sb.ToString();
    if (outFile != null) File.WriteAllText(outFile, json, new UTF8Encoding(false));
    Console.WriteLine(json);
    return 0;
  }

  static int CmdExport(string outDir, string sectionFilter, int maxPages) {
    Directory.CreateDirectory(outDir);
    foreach (string f in Directory.GetFiles(outDir, "*.json")) { try { File.Delete(f); } catch (Exception) { } }

    var all = ReadSections();
    var wanted = new List<SectionRef>();
    if (sectionFilter != null) {
      var ids = new HashSet<string>(sectionFilter.Split(','));
      foreach (SectionRef s in all) if (ids.Contains(s.Id)) wanted.Add(s);
    } else wanted = all;

    int totalPages = 0;
    foreach (SectionRef s in wanted) totalPages += s.PageIds.Count;
    if (maxPages > 0) totalPages = Math.Min(totalPages, maxPages);

    var started = Stopwatch.StartNew();
    var whole = new Stats();
    var files = new List<string>();
    int done = 0;
    Console.WriteLine("P 0 " + totalPages);

    for (int si = 0; si < wanted.Count; si++) {
      if (maxPages > 0 && done >= maxPages) break;
      SectionRef sec = wanted[si];
      var st = new Stats();
      string file = SafeFile(sec.Notebook + "-" + sec.Name, si + 1);
      string path = Path.Combine(outDir, file);
      double secStart = started.Elapsed.TotalSeconds;

      using (var w = new StreamWriter(path, false, new UTF8Encoding(false), 1 << 16)) {
        w.Write("{\"schema\":1,\"notebook\":" + J(sec.Notebook));
        w.Write(",\"section\":" + J(sec.Name));
        w.Write(",\"name\":" + J(sec.Notebook + " / " + sec.Name));
        w.Write(",\"sectionId\":" + J(sec.Id));
        w.Write(",\"pages\":[");
        bool firstPage = true;

        for (int pi = 0; pi < sec.PageIds.Count; pi++) {
          if (maxPages > 0 && done >= maxPages) break;
          string xml = Fetch(sec.PageIds[pi]);
          done++;
          if (xml == null) {
            st.PageFailures++;
            Console.WriteLine("ERR page fetch failed in section " + (si + 1) + " page " + (pi + 1));
            Console.WriteLine("P " + done + " " + totalPages);
            continue;
          }
          var doc = new XmlDocument();
          try { doc.LoadXml(xml); }
          catch (Exception) {
            st.PageFailures++;
            Console.WriteLine("ERR page xml unreadable in section " + (si + 1) + " page " + (pi + 1));
            Console.WriteLine("P " + done + " " + totalPages);
            continue;
          }
          var ns = new XmlNamespaceManager(doc.NameTable);
          ns.AddNamespace("one", NS);

          string title, ocrText;
          var items = ParsePage(doc, ns, st, out title, out ocrText);
          if (title.Length == 0 && pi < sec.PageNames.Count) title = Sanitize(sec.PageNames[pi]);

          // the page title is not positioned in the XML, so it rides above the content
          if (title.Length > 0) {
            double tminX = double.MaxValue, tminY = double.MaxValue;
            foreach (Item it in items) {
              if (it.X < tminX) tminX = it.X;
              if (it.Y < tminY) tminY = it.Y;
            }
            if (tminX == double.MaxValue) { tminX = 36 * PT; tminY = 36 * PT; }
            double fp = TITLE_FONT_PT * PT;
            Item ti = MakeText(tminX, tminY - fp * LINE_HEIGHT - 14, PAGE_W - MARGIN * 2, title, fp, DEFAULT_TEXT_COLOR, -1000000, -1);
            items.Add(ti);
          }

          double scale;
          var slices = Layout(items, st, out scale);
          st.OnenotePages++;

          for (int k = 0; k < slices.Count; k++) {
            if (!firstPage) w.Write(',');
            firstPage = false;
            w.Write("{\"source\":" + pi + ",\"slice\":" + k);
            if (k == 0) {
              w.Write(",\"title\":" + J(title));
              if (ocrText.Length > 0) w.Write(",\"ocrText\":" + J(ocrText));
              w.Write(",\"scale\":" + N(scale));
            }
            w.Write(",\"items\":[");
            for (int j = 0; j < slices[k].Items.Count; j++) {
              if (j > 0) w.Write(',');
              WriteItem(w, slices[k].Items[j]);
            }
            w.Write("]}");
            st.FlatPages++;
          }
          Console.WriteLine("P " + done + " " + totalPages);
          Console.Out.Flush();
        }

        w.Write("],\"stats\":");
        WriteStats(w, st, started.Elapsed.TotalSeconds - secStart);
        w.Write("}");
      }

      whole.OnenotePages += st.OnenotePages; whole.FlatPages += st.FlatPages;
      whole.Strokes += st.Strokes; whole.Points += st.Points; whole.Texts += st.Texts;
      whole.Images += st.Images; whole.Highlighters += st.Highlighters;
      whole.SkippedTables += st.SkippedTables; whole.SkippedImages += st.SkippedImages;
      whole.SkippedFiles += st.SkippedFiles; whole.SkippedTags += st.SkippedTags;
      whole.SkippedPrintouts += st.SkippedPrintouts; whole.Oversize += st.Oversize;
      whole.PageFailures += st.PageFailures;
      whole.MinScale = Math.Min(whole.MinScale, st.MinScale);

      if (st.OnenotePages == 0) { try { File.Delete(path); } catch (Exception) { } continue; }
      files.Add(file);
      Console.WriteLine("S " + files.Count + " " + wanted.Count + " " + file);
      Console.Out.Flush();
    }

    var idx = new StringBuilder();
    idx.Append("{\"schema\":1,\"files\":[");
    for (int i = 0; i < files.Count; i++) { if (i > 0) idx.Append(','); idx.Append(J(files[i])); }
    idx.Append("],\"stats\":");
    var sw = new StringWriter(CultureInfo.InvariantCulture);
    WriteStats(sw, whole, started.Elapsed.TotalSeconds);
    idx.Append(sw.ToString());
    idx.Append("}");
    File.WriteAllText(Path.Combine(outDir, "index.json"), idx.ToString(), new UTF8Encoding(false));

    Console.WriteLine("DONE");
    Console.WriteLine(idx.ToString());
    return 0;
  }

  /* ============================ entry point ============================ */

  // StrokeCollection is WPF, so the thread has to be STA or ISF parsing misbehaves.
  [STAThread]
  static int Main(string[] args) {
    try {
      string cmd = args.Length > 0 ? args[0] : "list";
      string outArg = null, sections = null;
      int maxPages = 0;
      for (int i = 1; i < args.Length; i++) {
        if (args[i] == "--out" && i + 1 < args.Length) outArg = args[++i];
        else if (args[i] == "--sections" && i + 1 < args.Length) sections = args[++i];
        else if (args[i] == "--max-pages" && i + 1 < args.Length) maxPages = int.Parse(args[++i]);
      }
      app = new Application();
      if (cmd == "list") return CmdList(outArg);
      if (cmd == "export") {
        if (outArg == null) { Console.Error.WriteLine("export needs --out <dir>"); return 2; }
        return CmdExport(outArg, sections, maxPages);
      }
      Console.Error.WriteLine("unknown command: " + cmd);
      return 2;
    } catch (Exception e) {
      Console.Error.WriteLine("FATAL " + e.GetType().Name + ": " + e.Message.Replace('\n', ' ').Replace('\r', ' '));
      return 1;
    }
  }
}
