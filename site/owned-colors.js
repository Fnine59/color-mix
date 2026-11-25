// Product-scoped prefix groups, independent of the color-name search.
(function (root) {
  const names = {'1': '中国传统色', '2': '木盒补充色', '6': '马卡龙', '7': '经典', '8': '莫兰迪'};
  const groupLabel = group => `${names[group.prefix] || '其他色系'} · ${group.prefix} 开头（${group.codes.length} 支）`;
  const inProduct = (colors, product = 'all') =>
    colors.filter(p => product === 'all' || p.products.includes(product));
  function groups(colors, product, owned) {
    const byPrefix = new Map();
    for (const paint of inProduct(colors, product)) {
      const prefix = paint.code.charAt(0);
      if (!/^\d$/.test(prefix)) continue;
      if (!byPrefix.has(prefix)) byPrefix.set(prefix, []);
      byPrefix.get(prefix).push(paint.code);
    }
    return [...byPrefix].sort(([a], [b]) => a.localeCompare(b)).map(([prefix, codes]) => {
      const selected = codes.filter(code => owned.has(code)).length;
      return {prefix, codes, selected, state: !selected ? 'none' : selected === codes.length ? 'all' : 'partial'};
    });
  }
  // Return a new set so callers can persist the same result used for recipes.
  function toggleGroup(owned, codes) {
    const select = !codes.every(code => owned.has(code)), next = new Set(owned);
    for (const code of codes) select ? next.add(code) : next.delete(code);
    return {owned: next, select};
  }
  const api = {inProduct, groups, toggleGroup, groupLabel};
  if (typeof module !== 'undefined') module.exports = api;
  else root.OwnedColors = api;
})(globalThis);
