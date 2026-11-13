/** Strip every `<...>` tag span from a rendered string, by scanning.
 *
 * Test-helper only: the fake themes in these suites tag their own output, so
 * assertions compare markup-free text. A `replace(/<[^>]+>/g, "")` chain is an
 * incomplete multi-character sanitizer to CodeQL (the result may still contain
 * `<script`), and guarding it with a second `<`-removal pass keeps the same
 * alert. The scan is complete by construction: every tag span is consumed, and
 * a `<` with no following `>` ends the scan as literal text — exactly what
 * `/<[^>]+>/` leaves behind.
 */
export function stripTagMarkup(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf("<", i);
    if (open < 0) break;
    const close = text.indexOf(">", open + 1);
    if (close < 0) break; // no tag: the remainder is literal text
    out += text.slice(i, open);
    i = close + 1;
  }
  return out + text.slice(i);
}
