/* Collapse / expand any card ("bubble") on the page, remembered per page in this
   browser. Cards are re-rendered on every run, so a MutationObserver adds the
   toggle to each new card and re-applies the saved state; pages need no changes.

   A card's key is its heading text (or "summary" for the hero card); its head --
   the h2 / .path-head / .hero line -- stays visible when collapsed. */
(() => {
  const STORE = 'eventstudy.collapsed:' + location.pathname.replace(/\/index\.html$/, '/');
  const load = () => { try { return new Set(JSON.parse(localStorage.getItem(STORE) || '[]')); } catch (e) { return new Set(); } };
  const save = s => { try { localStorage.setItem(STORE, JSON.stringify([...s])); } catch (e) { /* private mode */ } };
  let closed = load();

  const headOf = card => [...card.children].find(el =>
    el.matches('h2, .path-head, .hero, .card-head'));
  const keyOf = (card, head) => {
    if (head.matches('.hero')) return 'summary';
    const h = head.matches('h2') ? head : head.querySelector('h2');
    return (h ? h.textContent : head.textContent).trim().toLowerCase().slice(0, 60);
  };

  function setup(card) {
    if (card.dataset.tg || card.matches('.err, .muted, .hint') || card.closest('#gate')) return;
    const head = headOf(card);
    if (!head) return;
    const key = keyOf(card, head);
    card.dataset.tg = key;
    head.classList.add('keep');
    card.classList.add('has-tg');
    const b = document.createElement('button');
    b.className = 'card-tg';
    b.type = 'button';
    card.appendChild(b);
    const paint = () => {
      const c = closed.has(key);
      card.classList.toggle('collapsed', c);
      b.textContent = c ? '▸' : '▾';
      b.title = c ? 'Show this panel' : 'Hide this panel';
      b.setAttribute('aria-expanded', String(!c));
    };
    b.onclick = () => {
      closed = load();
      closed.has(key) ? closed.delete(key) : closed.add(key);
      save(closed);
      paint();
      // charts size themselves from their width, which is 0 while hidden
      if (!closed.has(key)) window.dispatchEvent(new Event('resize'));
    };
    paint();
  }

  const scan = root => (root.matches?.('.card') ? [root] : [])
    .concat([...(root.querySelectorAll?.('.card') || [])]).forEach(setup);
  const start = () => {
    scan(document.body);
    new MutationObserver(ms => ms.forEach(m => m.addedNodes.forEach(n => n.nodeType === 1 && scan(n))))
      .observe(document.body, {childList: true, subtree: true});
  };
  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', start) : start();
})();
