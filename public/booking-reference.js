(() => {
  'use strict';

  function control(reference) {
    const group = document.createElement('span');
    group.className = 'booking-reference-control';
    const value = document.createElement('span');
    value.className = 'booking-reference-value';
    value.textContent = reference;
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'booking-reference-copy';
    copy.textContent = 'Copy';
    copy.setAttribute('aria-label', 'Copy booking reference ' + reference);
    const status = document.createElement('span');
    status.className = 'booking-reference-status';
    status.setAttribute('role', 'status');
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(reference);
        status.textContent = 'Copied';
      } catch (_) {
        const selection = window.getSelection();
        if (selection) {
          const range = document.createRange();
          range.selectNodeContents(value);
          selection.removeAllRanges();
          selection.addRange(range);
        }
        status.textContent = 'Use your device’s Copy command.';
      }
    });
    group.append(value, copy, status);
    return group;
  }

  window.BookingReference = {control};
})();
