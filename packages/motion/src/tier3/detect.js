// Engine detection: which animation library drives this page. Recorded as metadata —
// it constrains the model search and names the engine in library entries.
// Lenis signals from docs/prior-art/lenis.md; framer-motion/react-spring leave no
// globals (inline-style motion is caught behaviorally by the sampler instead).
export const DETECT_SOURCE = `(() => {
  if (window.__mkDetect) return;
  window.__mkDetect = function () {
    const out = { engines: [], signals: {} };
    try {
      const html = document.documentElement;
      if (window.gsap) {
        out.engines.push('gsap');
        out.signals.gsapVersion = window.gsap.version || null;
        if (window.ScrollTrigger || (window.gsap.core && window.gsap.core.globals && window.gsap.core.globals().ScrollTrigger)) {
          out.engines.push('scrolltrigger');
        }
      }
      if (html.classList.contains('lenis') || window.lenis || window.Lenis) {
        out.engines.push('lenis');
        out.signals.lenis = {
          rootClass: html.classList.contains('lenis'),
          meta: window.lenis ? { version: window.lenis.version } : null,
        };
      }
      if (html.classList.contains('has-scroll-smooth') || document.querySelector('[data-scroll-container]')) {
        out.engines.push('locomotive');
      }
      if (window.anime) out.engines.push('animejs');
      if (window.Velocity) out.engines.push('velocity');
      if (document.querySelector('[data-framer-name], [data-framer-appear-id]')) out.engines.push('framer-sites');
      if (window.jQuery && window.jQuery.fx) out.engines.push('jquery');
    } catch (e) {}
    return out;
  };
})();`;
