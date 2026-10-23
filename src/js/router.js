/**
 * Tiny hash router.
 *
 * Hash routing keeps the app deployable as static files (including file://-like
 * hosting and simple subdirectory deployments) without server rewrites. A route
 * guard lets the editor protect unsaved changes before navigation. The router
 * also intercepts internal anchor clicks so guarded navigation cannot be
 * bypassed by a plain <a href="#/...">.
 */

export function parseHash(hash = globalThis.location?.hash || '') {
  const raw = String(hash).replace(/^#/, '') || '/';
  const [pathnamePart, queryPart = ''] = raw.split('?');
  let pathname = pathnamePart || '/';
  if (!pathname.startsWith('/')) pathname = `/${pathname}`;
  const normalized = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  return {
    pathname: normalized,
    query: Object.fromEntries(new URLSearchParams(queryPart)),
    search: queryPart ? `?${queryPart}` : '',
  };
}

export function buildHash(pathname, query = null) {
  let path = String(pathname || '/');
  if (!path.startsWith('/')) path = `/${path}`;
  if (!query) return `#${path}`;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value == null || value === '') continue;
    params.set(key, String(value));
  }
  const search = params.toString();
  return `#${path}${search ? `?${search}` : ''}`;
}

function matchRoute(route, pathname) {
  if (!route?.path) return null;
  const routeParts = route.path.split('/').filter(Boolean);
  const pathParts = pathname.split('/').filter(Boolean);
  if (routeParts.length !== pathParts.length) return null;
  const params = {};
  for (let index = 0; index < routeParts.length; index += 1) {
    const expected = routeParts[index];
    const actual = pathParts[index];
    if (expected.startsWith(':')) {
      try {
        params[expected.slice(1)] = decodeURIComponent(actual);
      } catch {
        params[expected.slice(1)] = actual;
      }
    } else if (expected !== actual) {
      return null;
    }
  }
  return params;
}

export class HashRouter {
  #routes;
  #onRender;
  #onError;
  #guard = null;
  #cleanup = null;
  #current = null;
  #allowedHash = null;
  #lastCommittedHash = null;
  #started = false;
  #rendering = false;
  #pending = null;
  #boundHashChange = () => this.#handleHashChange();
  #boundClick = (event) => this.#handleClick(event);

  constructor({ routes, onRender, onError = null }) {
    this.#routes = routes;
    this.#onRender = onRender;
    this.#onError = onError;
  }

  get current() {
    return this.#current;
  }

  start() {
    if (this.#started) return;
    this.#started = true;
    window.addEventListener('hashchange', this.#boundHashChange);
    document.addEventListener('click', this.#boundClick, true);
    this.#lastCommittedHash = globalThis.location?.hash || '#/';
    if (!globalThis.location?.hash) {
      try {
        history.replaceState(null, '', '#/');
      } catch {
        // Non-fatal: rendering still works without address bar updates.
      }
    }
    return this.#resolve(globalThis.location?.hash || '#/', { initial: true });
  }

  destroy() {
    window.removeEventListener('hashchange', this.#boundHashChange);
    document.removeEventListener('click', this.#boundClick, true);
    this.#cleanup?.();
    this.#cleanup = null;
    this.#started = false;
  }

  setGuard(guard) {
    this.#guard = typeof guard === 'function' ? guard : null;
  }

  /** Registers cleanup for the currently rendered view. */
  setCleanup(cleanup) {
    this.#cleanup = typeof cleanup === 'function' ? cleanup : null;
  }

  async navigate(path, { replace = false } = {}) {
    const target = path.startsWith('#') ? path : buildHash(path);
    if (target === (globalThis.location?.hash || '#/')) return true;
    if (this.#guard) {
      const allowed = await this.#guard({ target, from: this.#current });
      if (allowed === false) return false;
    }
    this.#allowedHash = target;
    if (replace) {
      try {
        history.replaceState(null, '', target);
        this.#lastCommittedHash = target;
        await this.#resolve(target, { replace: true });
      } catch {
        globalThis.location.hash = target;
      }
      return true;
    }
    globalThis.location.hash = target;
    return true;
  }

  /** Re-renders the current route (used after restores/clears). */
  refresh() {
    return this.#resolve(globalThis.location?.hash || '#/');
  }

  async #handleHashChange() {
    if (this.#rendering) {
      this.#pending = globalThis.location?.hash || '#/';
      return;
    }
    const hash = globalThis.location?.hash || '#/';
    if (hash === this.#allowedHash) {
      this.#allowedHash = null;
      await this.#resolve(hash);
      return;
    }
    if (this.#guard) {
      const allowed = await this.#guard({ target: hash, from: this.#current });
      if (allowed === false) {
        try {
          history.replaceState(null, '', this.#lastCommittedHash || '#/');
        } catch {
          globalThis.location.hash = this.#lastCommittedHash || '#/';
        }
        return;
      }
    }
    await this.#resolve(hash);
  }

  async #handleClick(event) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!anchor || anchor.target === '_blank' || anchor.hasAttribute('download')) return;
    const href = anchor.getAttribute('href') || '';
    if (!href.startsWith('#/')) return;
    const url = new URL(anchor.href, globalThis.location.href);
    if (url.origin !== globalThis.location.origin) return;
    event.preventDefault();
    await this.navigate(`#${url.hash.replace(/^#/, '')}`);
  }

  async #resolve(hash, { initial = false, replace = false } = {}) {
    if (this.#rendering) {
      this.#pending = hash;
      return;
    }
    this.#rendering = true;
    try {
      const parsed = parseHash(hash);
      let matched = null;
      let params = {};
      for (const route of this.#routes) {
        const result = matchRoute(route, parsed.pathname);
        if (result) {
          matched = route;
          params = result;
          break;
        }
      }
      if (!matched) {
        const notFound = this.#routes.find((route) => route.notFound);
        matched = notFound ? { ...notFound, path: parsed.pathname } : { name: 'not-found', path: parsed.pathname };
      }

      this.#cleanup?.();
      this.#cleanup = null;

      const routeContext = {
        name: matched.name,
        pathname: parsed.pathname,
        query: parsed.query,
        params,
        hash,
        initial,
        replace,
      };

      let result;
      try {
        result = await this.#onRender(matched, routeContext);
      } catch (error) {
        this.#onError?.(error, routeContext);
        if (this.#onError) return;
        throw error;
      }

      this.#current = { ...routeContext, route: matched };
      this.#lastCommittedHash = hash;
      if (typeof result === 'function') this.#cleanup = result;
      else if (result?.cleanup) this.#cleanup = result.cleanup;
      this.setGuard(result?.guard || null);
      if (result?.title) document.title = result.title;
    } finally {
      this.#rendering = false;
      if (this.#pending) {
        const next = this.#pending;
        this.#pending = null;
        // Avoid recursively re-entering while unwinding.
        queueMicrotask(() => this.#resolve(next));
      }
    }
  }
}
