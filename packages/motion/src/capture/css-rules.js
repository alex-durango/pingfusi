// Cross-origin stylesheets make document.styleSheets[i].cssRules throw, so on real sites
// the in-page CSSOM walk finds nothing. The CDP CSS domain sees every sheet's text
// regardless of origin — extract @keyframes blocks from there as the fallback.

export function extractKeyframesRule(cssText, name) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    `@(?:-webkit-)?keyframes\\s+(?:${esc}|"${esc}"|'${esc}')\\s*\\{`,
    'g',
  );
  let match;
  let last = null;
  while ((match = re.exec(cssText))) {
    // brace-count to the end of the block (heuristic: ignores braces inside strings,
    // which do not realistically appear inside keyframe declarations)
    let depth = 1;
    let i = match.index + match[0].length;
    while (i < cssText.length && depth > 0) {
      const ch = cssText[i];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      i++;
    }
    if (depth === 0) last = cssText.slice(match.index, i); // last definition wins (cascade order approximation)
  }
  return last;
}

export async function keyframesRulesViaCdp(cdp, names) {
  if (!names.length) return {};
  const sheets = [];
  const handler = (e) => sheets.push(e.header);
  cdp.on('CSS.styleSheetAdded', handler);
  try {
    await cdp.send('DOM.enable');
    await cdp.send('CSS.enable'); // replays styleSheetAdded for every existing sheet
    await new Promise((r) => setTimeout(r, 300));
    const found = {};
    for (const header of sheets) {
      let text;
      try {
        ({ text } = await cdp.send('CSS.getStyleSheetText', { styleSheetId: header.styleSheetId }));
      } catch {
        continue;
      }
      for (const name of names) {
        const rule = extractKeyframesRule(text, name);
        if (rule) found[name] = rule;
      }
    }
    return found;
  } finally {
    cdp.off('CSS.styleSheetAdded', handler);
    await cdp.send('CSS.disable').catch(() => {});
    await cdp.send('DOM.disable').catch(() => {});
  }
}
