import { icon } from './icons.js';
import { escapeHtml, friendlyErrorMessage } from './utils.js';

/**
 * Creates an element safely. Strings become text nodes, so this helper is
 * safe for all user-derived content.
 */
export function h(tag, attributes = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes || {})) {
    if (value == null || value === false) continue;
    if (key === 'class' || key === 'className') element.className = value;
    else if (key === 'dataset') Object.assign(element.dataset, value);
    else if (key === 'style' && typeof value === 'object') Object.assign(element.style, value);
    else if (key.startsWith('on') && typeof value === 'function') element.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'html') element.innerHTML = value; // Only for trusted icon/UI markup.
    else if (key === 'text') element.textContent = value;
    else if (value === true) element.setAttribute(key, '');
    else element.setAttribute(key, value);
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return element;
}

export function iconSpan(name, options = {}) {
  const span = document.createElement('span');
  span.className = 'inline-flex shrink-0';
  span.innerHTML = icon(name, options);
  return span;
}

/* ============================================================
   Toasts
   ============================================================ */

const toastRoot = () => document.getElementById('toast-root');
const activeToasts = new Map();
let toastCounter = 0;

export function toast(message, options = {}) {
  const {
    type = 'info',
    title = '',
    duration = type === 'error' ? 8000 : 4500,
    actions = [],
    dismissible = true,
    id = `toast-${++toastCounter}`,
  } = typeof options === 'string' ? { type: options } : options;

  const root = toastRoot();
  if (!root) return { close: () => {} };
  if (activeToasts.has(id)) activeToasts.get(id).close();

  const icons = {
    success: 'check',
    error: 'warning',
    warning: 'warning',
    info: 'info',
  };
  const element = h('div', { class: `toast toast--${type}`, role: 'status', dataset: { toastId: id } });
  element.append(iconSpan(icons[type] || 'info', { size: 17, className: 'toast__icon' }));

  const content = h('div', { class: 'toast__content' });
  if (title) content.append(h('div', { class: 'toast__title', text: title }));
  content.append(h('div', { class: 'toast__message', text: message }));
  if (actions.length) {
    const actionRow = h('div', { class: 'toast__actions' });
    for (const action of actions) {
      actionRow.append(
        h('button', {
          type: 'button',
          class: 'btn btn--sm',
          text: action.label,
          onclick: () => {
            action.onClick?.();
            if (action.close !== false) close();
          },
        }),
      );
    }
    content.append(actionRow);
  }
  element.append(content);

  if (dismissible) {
    const closeButton = h('button', {
      type: 'button',
      class: 'toast__close',
      'aria-label': 'Dismiss notification',
      html: icon('x', { size: 14 }),
      onclick: () => close(),
    });
    element.append(closeButton);
  }

  let timer = null;
  const close = () => {
    if (!element.isConnected) return;
    clearTimeout(timer);
    element.classList.add('toast--out');
    setTimeout(() => element.remove(), 190);
    activeToasts.delete(id);
  };

  activeToasts.set(id, { close, element });
  root.append(element);
  while (root.children.length > 4) root.firstElementChild?.remove();

  if (duration > 0) timer = setTimeout(close, duration);
  element.addEventListener('mouseenter', () => clearTimeout(timer));
  element.addEventListener('mouseleave', () => {
    if (duration > 0) timer = setTimeout(close, 2200);
  });
  return { close, element };
}

/* ============================================================
   Modals
   ============================================================ */

const modalStack = [];
let previousFocus = null;
let bodyOverflow = '';

export function openModal(options = {}) {
  const {
    title = '',
    description = '',
    icon: iconName = null,
    iconTone = 'accent',
    body = null,
    footer = null,
    size = 'md',
    onClose = null,
    closeOnBackdrop = true,
    closeLabel = 'Close dialog',
    initialFocus = null,
    persistent = false,
  } = options;

  const root = document.getElementById('modal-root');
  if (!root) return null;

  const id = `modal-${Date.now()}-${modalStack.length}`;
  const backdrop = h('div', { class: 'modal-backdrop' });
  const dialog = h('div', {
    class: `modal ${size === 'lg' ? 'modal--lg' : size === 'xl' ? 'modal--xl' : size === 'sm' ? '' : 'modal--md'}`,
    role: 'dialog',
    'aria-modal': 'true',
    'aria-labelledby': `${id}-title`,
    id,
    tabindex: '-1',
  });

  const header = h('div', { class: 'modal__head' });
  if (iconName) {
    const toneClass = iconTone === 'danger' ? ' modal__icon--danger' : iconTone === 'warning' ? ' modal__icon--warning' : '';
    const iconBox = h('div', { class: `modal__icon${toneClass}` });
    iconBox.innerHTML = icon(iconName, { size: 19 });
    header.append(iconBox);
  }
  const titles = h('div', { class: 'modal__titles' });
  titles.append(h('h2', { class: 'modal__title', id: `${id}-title`, text: title }));
  if (description) titles.append(h('p', { class: 'modal__desc', text: description }));
  header.append(titles);
  const closeButton = h('button', {
    type: 'button',
    class: 'btn btn--icon btn--ghost modal__close',
    'aria-label': closeLabel,
    html: icon('x', { size: 18 }),
    onclick: () => close('dismiss'),
  });
  header.append(closeButton);

  const bodyElement = h('div', { class: 'modal__body' });
  if (body instanceof Node) bodyElement.append(body);
  else if (typeof body === 'string') bodyElement.innerHTML = body; // Trusted UI markup only.
  const footerElement = h('div', { class: 'modal__footer' });
  if (footer instanceof Node) footerElement.append(footer);
  else if (typeof footer === 'string') footerElement.innerHTML = footer;

  dialog.append(header, bodyElement, footerElement);
  backdrop.append(dialog);

  const stackEntry = { id, element: backdrop, dialog, close, onClose };
  modalStack.push(stackEntry);

  if (modalStack.length === 1) {
    previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    bodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const app = document.getElementById('app');
    if (app) app.inert = true;
  }

  let closed = false;
  function close(result = null) {
    if (closed) return;
    closed = true;
    backdrop.style.pointerEvents = 'none';
    backdrop.style.opacity = '0';
    backdrop.style.transition = 'opacity 120ms ease';
    setTimeout(() => {
      backdrop.remove();
      const index = modalStack.findIndex((entry) => entry.id === id);
      if (index >= 0) modalStack.splice(index, 1);
      if (!modalStack.length) {
        document.body.style.overflow = bodyOverflow;
        const app = document.getElementById('app');
        if (app) app.inert = false;
        if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
        previousFocus = null;
      }
      onClose?.(result);
    }, 120);
  }

  const onKeydown = (event) => {
    if (modalStack.at(-1)?.id !== id) return;
    if (event.key === 'Escape' && !persistent) {
      event.preventDefault();
      event.stopPropagation();
      close('dismiss');
      return;
    }
    if (event.key !== 'Tab') return;
    const focusables = [...dialog.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )].filter((element) => element.offsetParent !== null);
    if (!focusables.length) {
      event.preventDefault();
      dialog.focus();
      return;
    }
    const first = focusables[0];
    const last = focusables.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  document.addEventListener('keydown', onKeydown, true);

  const originalClose = close;
  stackEntry.close = (result) => {
    document.removeEventListener('keydown', onKeydown, true);
    originalClose(result);
  };
  // Replace closure used by button/backdrop.
  closeButton.onclick = () => stackEntry.close('dismiss');

  backdrop.addEventListener('mousedown', (event) => {
    if (event.target === backdrop && closeOnBackdrop && !persistent) stackEntry.close('backdrop');
  });

  root.append(backdrop);
  dialog.focus({ preventScroll: true });
  requestAnimationFrame(() => {
    const focusTarget = typeof initialFocus === 'string' ? dialog.querySelector(initialFocus) : initialFocus;
    const autofocus = dialog.querySelector('[autofocus]');
    (focusTarget || autofocus || dialog).focus?.({ preventScroll: true });
  });

  return {
    element: dialog,
    body: bodyElement,
    footer: footerElement,
    header,
    close: (result) => stackEntry.close(result),
    setTitle: (value) => {
      const heading = titles.querySelector('.modal__title');
      if (heading) heading.textContent = value;
    },
    setBody: (value) => {
      bodyElement.replaceChildren();
      if (value instanceof Node) bodyElement.append(value);
      else bodyElement.innerHTML = value;
    },
    setFooter: (value) => {
      footerElement.replaceChildren();
      footerElement.hidden = value == null;
      if (value instanceof Node) footerElement.append(value);
      else if (typeof value === 'string') footerElement.innerHTML = value;
    },
    get isOpen() {
      return !closed;
    },
  };
}

export function isAnyModalOpen() {
  return modalStack.length > 0;
}

export function closeTopModal(result = 'dismiss') {
  modalStack.at(-1)?.close?.(result);
}

export function confirmDialog({
  title = 'Are you sure?',
  message = '',
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
  iconName = danger ? 'warning' : 'info',
  details = [],
} = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const body = h('div');
    body.append(h('p', { class: 'text-sm', style: { margin: '0', color: 'var(--text-soft)', lineHeight: '1.6' }, text: message }));
    if (details.length) {
      const list = h('ul', { class: 'confirm-list' });
      for (const detail of details) list.append(h('li', { text: detail }));
      body.append(list);
    }
    const footer = h('div', { class: 'btn-row' });
    const modal = openModal({
      title,
      icon: iconName,
      iconTone: danger ? 'danger' : 'accent',
      body,
      footer,
      closeOnBackdrop: false,
      onClose: () => {
        if (!settled) {
          settled = true;
          resolve(false);
        }
      },
    });
    const cancel = h('button', {
      type: 'button',
      class: 'btn',
      text: cancelLabel,
      onclick: () => modal.close(false),
    });
    const confirm = h('button', {
      type: 'button',
      class: `btn ${danger ? 'btn--danger' : 'btn--primary'}`,
      text: confirmLabel,
      onclick: () => {
        settled = true;
        modal.close(true);
        if (!modalStack.length) resolve(true);
        else setTimeout(() => resolve(true), 0);
      },
    });
    footer.append(cancel, confirm);
    requestAnimationFrame(() => confirm.focus());
    // The onClose callback resolves false after animation; ensure resolve(true)
    // is not overwritten by the closure.
    const originalClose = modal.close;
    modal.close = (result) => {
      if (result === true) settled = true;
      originalClose(result);
      if (result === true) resolve(true);
    };
  });
}

export function promptDialog({
  title = 'Enter a value',
  label = 'Name',
  value = '',
  placeholder = '',
  help = '',
  confirmLabel = 'Save',
  maxLength = 120,
  required = true,
  validate = null,
  inputType = 'text',
  iconName = 'pencil',
} = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let result = null;
    const form = h('form', { class: 'field', novalidate: true });
    form.append(h('label', { class: 'label', for: 'prompt-input', text: label }));
    const input = h('input', {
      class: 'input',
      id: 'prompt-input',
      type: inputType,
      value,
      placeholder,
      maxlength: String(maxLength),
      autofocus: true,
    });
    form.append(input);
    if (help) form.append(h('div', { class: 'field-hint', text: help }));
    const error = h('div', { class: 'field-error', hidden: true });
    form.append(error);

    const footer = h('div', { class: 'btn-row' });
    const modal = openModal({
      title,
      icon: iconName,
      body: form,
      footer,
      closeOnBackdrop: false,
      onClose: () => {
        if (!settled) {
          settled = true;
          resolve(null);
        }
      },
    });
    const cancel = h('button', { type: 'button', class: 'btn', text: 'Cancel', onclick: () => modal.close(null) });
    const submit = h('button', { type: 'submit', class: 'btn btn--primary', text: confirmLabel, form });
    footer.append(cancel, submit);

    const finish = () => {
      const trimmed = input.value.trim();
      let validationError = null;
      if (required && !trimmed) validationError = `${label} is required.`;
      else {
        try {
          validationError = validate?.(trimmed) || null;
        } catch (validationException) {
          validationError = friendlyErrorMessage(validationException);
        }
      }
      if (validationError) {
        error.textContent = validationError;
        error.hidden = false;
        input.setAttribute('aria-invalid', 'true');
        input.focus();
        return;
      }
      settled = true;
      result = trimmed;
      modal.close(result);
      resolve(result);
    };

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      finish();
    });
    setTimeout(() => {
      input.focus();
      input.select();
    }, 30);
  });
}

/* ============================================================
   Context menus / dropdowns
   ============================================================ */

let openMenuElement = null;
let openMenuCleanup = null;

export function closeMenu() {
  if (openMenuCleanup) openMenuCleanup();
  openMenuElement?.remove();
  openMenuElement = null;
  openMenuCleanup = null;
}

export function openMenu(anchor, items = [], { align = 'end', width = null } = {}) {
  closeMenu();
  if (!anchor) return;
  const menu = h('div', { class: 'menu', role: 'menu', tabindex: '-1' });
  if (width) menu.style.width = `${width}px`;

  const actionable = [];
  for (const item of items) {
    if (!item || item.separator) {
      menu.append(h('div', { class: 'menu__sep', role: 'separator' }));
      continue;
    }
    const button = h('button', {
      type: 'button',
      class: `menu__item${item.danger ? ' menu__item--danger' : ''}`,
      role: 'menuitem',
      disabled: item.disabled,
    });
    if (item.icon) {
      const holder = h('span', { class: 'inline-flex', html: icon(item.icon, { size: 15 }) });
      button.append(holder);
    }
    button.append(h('span', { text: item.label }));
    if (item.shortcut) button.append(h('span', { class: 'ml-auto faint', style: { fontSize: '9px' }, text: item.shortcut }));
    button.addEventListener('click', () => {
      closeMenu();
      item.onSelect?.();
    });
    menu.append(button);
    if (!item.disabled) actionable.push(button);
  }

  document.body.append(menu);
  openMenuElement = menu;
  const rect = anchor.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  let left = align === 'end' ? rect.right - menuRect.width : rect.left;
  let top = rect.bottom + 6;
  if (left + menuRect.width > window.innerWidth - 8) left = window.innerWidth - menuRect.width - 8;
  if (left < 8) left = 8;
  if (top + menuRect.height > window.innerHeight - 8) top = Math.max(8, rect.top - menuRect.height - 6);
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;

  const onDocPointer = (event) => {
    if (!menu.contains(event.target) && !anchor.contains(event.target)) closeMenu();
  };
  const onKey = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeMenu();
      anchor.focus?.();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || !actionable.length) return;
    event.preventDefault();
    const current = document.activeElement;
    let index = actionable.indexOf(current);
    if (event.key === 'ArrowDown') index = index < 0 ? 0 : (index + 1) % actionable.length;
    if (event.key === 'ArrowUp') index = index <= 0 ? actionable.length - 1 : index - 1;
    if (event.key === 'Home') index = 0;
    if (event.key === 'End') index = actionable.length - 1;
    actionable[index]?.focus();
  };
  const onScroll = () => closeMenu();
  document.addEventListener('pointerdown', onDocPointer, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', onScroll);
  window.addEventListener('scroll', onScroll, true);
  openMenuCleanup = () => {
    document.removeEventListener('pointerdown', onDocPointer, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', onScroll);
    window.removeEventListener('scroll', onScroll, true);
  };
  requestAnimationFrame(() => (actionable[0] || menu).focus({ preventScroll: true }));
}

/* ============================================================
   Small UI helpers
   ============================================================ */

export function setButtonBusy(button, busy, busyLabel = 'Working…') {
  if (!button) return;
  if (busy) {
    if (!button.dataset.originalHtml) button.dataset.originalHtml = button.innerHTML;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.innerHTML = `<span class="spinner" aria-hidden="true"></span><span>${escapeHtml(busyLabel)}</span>`;
  } else {
    button.disabled = false;
    button.removeAttribute('aria-busy');
    if (button.dataset.originalHtml) {
      button.innerHTML = button.dataset.originalHtml;
      delete button.dataset.originalHtml;
    }
  }
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    const ok = document.execCommand?.('copy');
    area.remove();
    return Boolean(ok);
  }
}

export function emptyState({ iconName = 'fileText', title, description, actions = [] }) {
  const container = h('div', { class: 'empty-state' });
  const iconBox = h('div', { class: 'empty-state__icon' });
  iconBox.innerHTML = icon(iconName, { size: 26 });
  container.append(iconBox, h('h2', { text: title }), h('p', { text: description }));
  if (actions.length) {
    const row = h('div', { class: 'empty-state__actions' });
    for (const action of actions) {
      row.append(
        h('button', {
          type: 'button',
          class: `btn ${action.primary ? 'btn--primary' : ''}`,
          html: `${action.icon ? icon(action.icon, { size: 15 }) : ''}<span>${escapeHtml(action.label)}</span>`,
          onclick: action.onClick,
        }),
      );
    }
    container.append(row);
  }
  return container;
}

export function createSwitch({ checked, label, description, onChange, id = `switch-${Math.random().toString(36).slice(2)}` }) {
  const wrapper = h('label', { class: 'switch', for: id });
  const text = h('span', { class: 'switch__text' });
  text.append(document.createTextNode(label));
  if (description) text.append(h('span', { class: 'switch__desc', text: description }));
  const input = h('input', { type: 'checkbox', id, checked });
  const track = h('span', { class: 'switch__track', 'aria-hidden': 'true' });
  wrapper.append(text, input, track);
  input.addEventListener('change', () => onChange?.(input.checked));
  return wrapper;
}

export function createSelect({ id, label, value, options, onChange, help }) {
  const field = h('div', { class: 'field' });
  const selectId = id || `select-${Math.random().toString(36).slice(2)}`;
  field.append(h('label', { class: 'label', for: selectId, text: label }));
  const select = h('select', { class: 'select', id: selectId });
  for (const option of options) {
    const optionEl = h('option', { value: option.value, text: option.label });
    if (String(option.value) === String(value)) optionEl.selected = true;
    select.append(optionEl);
  }
  select.addEventListener('change', () => onChange?.(select.value));
  field.append(select);
  if (help) field.append(h('div', { class: 'field-hint', text: help }));
  return field;
}

export function createRange({ id, label, value, min, max, step = 1, suffix = '', onChange, format = null, help }) {
  const field = h('div', { class: 'field' });
  const rangeId = id || `range-${Math.random().toString(36).slice(2)}`;
  const header = h('label', { class: 'label', for: rangeId });
  header.append(h('span', { text: label }));
  const output = h('span', { class: 'label__value', text: format ? format(value) : `${value}${suffix}` });
  header.append(output);
  const range = h('input', { class: 'range', id: rangeId, type: 'range', min, max, step, value });
  range.addEventListener('input', () => {
    const current = Number(range.value);
    output.textContent = format ? format(current) : `${current}${suffix}`;
    onChange?.(current);
  });
  field.append(header, range);
  if (help) field.append(h('div', { class: 'field-hint', text: help }));
  return field;
}

export function metaRow(parts) {
  const row = h('div', { class: 'script-row__meta' });
  parts.forEach((part, index) => {
    if (index > 0) row.append(h('span', { class: 'dot' }));
    if (part instanceof Node) row.append(part);
    else row.append(h('span', { text: part }));
  });
  return row;
}

export function badge(text, kind = '') {
  return h('span', { class: `badge${kind ? ` badge--${kind}` : ''}`, text });
}

export function iconLabel(name, label, size = 15) {
  const fragment = document.createDocumentFragment();
  fragment.append(iconSpan(name, { size }), document.createTextNode(label));
  return fragment;
}

export function button(label, { iconName = null, variant = '', size = '', type = 'button', onClick, title, disabled = false, className = '' } = {}) {
  const element = h('button', {
    type,
    class: `btn${variant ? ` btn--${variant}` : ''}${size ? ` btn--${size}` : ''}${className ? ` ${className}` : ''}`,
    title,
    disabled,
  });
  if (iconName) element.append(iconSpan(iconName, { size: size === 'sm' ? 14 : 16 }));
  if (label) element.append(h('span', { text: label }));
  if (onClick) element.addEventListener('click', onClick);
  return element;
}

export function iconButton(name, label, { size = 'md', onClick, title = label, className = '' } = {}) {
  const element = h('button', {
    type: 'button',
    class: `btn btn--icon${size === 'sm' ? ' btn--sm' : ''}${className ? ` ${className}` : ''}`,
    'aria-label': label,
    title,
  });
  element.innerHTML = icon(name, { size: size === 'sm' ? 15 : 18 });
  if (onClick) element.addEventListener('click', onClick);
  return element;
}

export function createTextInput({
  id,
  label,
  value = '',
  placeholder = '',
  type = 'text',
  help = '',
  min,
  max,
  step,
  maxlength,
  autocomplete,
  onInput,
  onChange,
  required = false,
  disabled = false,
}) {
  const field = h('div', { class: 'field' });
  const inputId = id || `input-${Math.random().toString(36).slice(2)}`;
  if (label) field.append(h('label', { class: 'label', for: inputId, text: label }));
  const input = h('input', {
    class: 'input',
    id: inputId,
    type,
    value,
    placeholder,
    min,
    max,
    step,
    maxlength,
    autocomplete,
    required,
    disabled,
  });
  if (onInput) input.addEventListener('input', () => onInput(input.value, input));
  if (onChange) input.addEventListener('change', () => onChange(input.value, input));
  field.append(input);
  if (help) field.append(h('div', { class: 'field-hint', text: help }));
  field.input = input;
  return field;
}

export function createTextarea({
  id,
  label,
  value = '',
  placeholder = '',
  rows = 5,
  help = '',
  maxlength,
  onInput,
  onChange,
}) {
  const field = h('div', { class: 'field' });
  const inputId = id || `textarea-${Math.random().toString(36).slice(2)}`;
  if (label) field.append(h('label', { class: 'label', for: inputId, text: label }));
  const textarea = h('textarea', {
    class: 'textarea',
    id: inputId,
    rows,
    placeholder,
    maxlength,
  });
  textarea.value = value;
  if (onInput) textarea.addEventListener('input', () => onInput(textarea.value, textarea));
  if (onChange) textarea.addEventListener('change', () => onChange(textarea.value, textarea));
  field.append(textarea);
  if (help) field.append(h('div', { class: 'field-hint', text: help }));
  field.input = textarea;
  return field;
}

export function createColorInput({ id, label, value, onChange }) {
  const field = h('div', { class: 'field' });
  const inputId = id || `color-${Math.random().toString(36).slice(2)}`;
  field.append(h('label', { class: 'label', for: inputId, text: label }));
  const row = h('div', { class: 'color-row' });
  const color = h('input', { type: 'color', id: inputId, value });
  const text = h('input', { class: 'input', type: 'text', value, maxlength: '7', spellcheck: 'false' });
  const sync = (next, source) => {
    const result = parseHexColor(next);
    if (!result) return;
    color.value = result;
    if (source !== 'text') text.value = result;
    if (source !== 'color') {
      // Keep the text field editable; the caller receives the valid value.
    }
    onChange?.(result);
  };
  color.addEventListener('input', () => sync(color.value, 'color'));
  text.addEventListener('change', () => sync(text.value, 'text'));
  row.append(color, text);
  field.append(row);
  field.input = color;
  return field;
}

function parseHexColor(value) {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(value || '').trim());
  if (!match) return null;
  if (match[1].length === 3) return `#${match[1].split('').map((c) => c + c).join('')}`.toLowerCase();
  return `#${match[1].toLowerCase()}`;
}

export function segmentedControl({ options, value, onChange, label = 'View mode' }) {
  const group = h('div', { class: 'segmented', role: 'group', 'aria-label': label });
  for (const option of options) {
    const buttonEl = h('button', {
      type: 'button',
      text: option.label,
      'aria-pressed': String(option.value === value),
      title: option.title || '',
    });
    buttonEl.addEventListener('click', () => {
      for (const child of group.children) child.setAttribute('aria-pressed', 'false');
      buttonEl.setAttribute('aria-pressed', 'true');
      onChange?.(option.value);
    });
    group.append(buttonEl);
  }
  return group;
}

export function settingRow(label, description, control) {
  const row = h('div', { class: 'setting-row' });
  const text = h('div');
  text.append(h('div', { class: 'setting-row__label', text: label }));
  if (description) text.append(h('div', { class: 'setting-row__desc', text: description }));
  row.append(text);
  if (control) row.append(control);
  return row;
}

/** Detects a shortcut string that conflicts with another action. */
export function shortcutConflict(shortcut, map, exceptAction) {
  if (!shortcut) return null;
  for (const [action, value] of Object.entries(map)) {
    if (action !== exceptAction && value === shortcut) return action;
  }
  return null;
}
