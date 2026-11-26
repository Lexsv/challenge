// Accept a bounded subset of Unicode-mode ECMAScript regexes from untrusted catalogs.
// Groups can branch or be optional, never loop. At most one atomic repeat may be
// unbounded, and only in a whole-string match. AJV evaluates the original pattern.
export function supportedPattern(pattern) {
  if (typeof pattern !== "string" || pattern.length > 2048) return false;
  const anchored = pattern.startsWith("^") && pattern.endsWith("$");
  const body = anchored ? pattern.slice(1, -1) : pattern;
  const atom =
    /\[(?:\\[dDsSwW.\-\\\[\]^]|[^\]\\])+\]|\\[dDsSwW.^$*+?(){}|\\[\]\-]|[^\\[\](){}|?*+^$]/uy;
  const quantity = /\{(\d{1,3})(?:,(\d{1,3}))?\}/y;
  let offset = 0,
    unbounded = 0;
  function group(depth) {
    if (depth > 12) throw Error();
    let alternatives = 0,
      paths = 1;
    while (offset < body.length && body[offset] !== ")") {
      if (body[offset] === "|") {
        if (!depth) throw Error();
        alternatives += paths;
        paths = 1;
        offset++;
        continue;
      }
      const nested = body[offset] === "(";
      if (nested) {
        offset += body.startsWith("(?:", offset) ? 3 : 1;
        paths *= group(depth + 1);
        if (body[offset++] !== ")") throw Error();
      } else {
        atom.lastIndex = offset;
        if (!atom.test(body)) throw Error();
        offset = atom.lastIndex;
      }
      const q = body[offset];
      if (q === "?") {
        paths *= 2;
        offset++;
      } else if (q === "+" || q === "*") {
        if (nested || !anchored || ++unbounded > 1) throw Error();
        offset++;
      } else if (q === "{") {
        quantity.lastIndex = offset;
        const repeat = quantity.exec(body);
        if (nested || !repeat) throw Error();
        const hi = Number(repeat[2] ?? repeat[1]),
          lo = Number(repeat[1]);
        if (hi > 128 || hi < lo) throw Error();
        paths *= 1 + hi - lo;
        offset = quantity.lastIndex;
      }
      if (alternatives + paths > 4096) throw Error();
    }
    return alternatives + paths;
  }
  try {
    group(0);
    return offset === body.length && !!new RegExp(pattern, "u");
  } catch {
    return false;
  }
}
