(() => {
  'use strict';

  const waitOptions = [5, 10, 15, 20, 30];
  const placeId = /^[A-Za-z0-9_-]{1,255}$/;
  const node = (tag, text) => {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    return element;
  };
  const button = text => {
    const element = node('button', text);
    element.type = 'button';
    return element;
  };

  function createEditor(container, prefix, onChange = () => {}) {
    if (!container) return null;
    const list = node('div');
    const add = button('+ Add a Stop');
    const policy = node('p','The first 5 minutes at each stop are free. Contact Dispatch or book hourly service for stops over 30 minutes.');
    add.className = 'booking-stop-add';
    policy.className = 'booking-stops-note';
    container.classList.add('booking-stop-editor');
    container.append(list, add, policy);
    const entries = [];
    let enabled = true, serial = 0;

    function sync() {
      add.hidden = entries.length >= 3;
      policy.hidden = entries.length === 0;
      add.disabled = !enabled;
      add.textContent = entries.length ? '+ Add Another Stop' : '+ Add a Stop';
      for (const [index, entry] of entries.entries()) {
        const label = 'Stop ' + (index + 1);
        entry.legend.textContent = label;
        entry.addressLabel.textContent = label + ' address';
        entry.waitLabel.textContent = 'Expected waiting time at ' + label;
        entry.remove.setAttribute('aria-label', 'Remove ' + label);
        entry.up.setAttribute('aria-label', 'Move ' + label + ' earlier');
        entry.down.setAttribute('aria-label', 'Move ' + label + ' later');
        entry.address.disabled = entry.wait.disabled = entry.remove.disabled = !enabled;
        entry.up.disabled = !enabled || index === 0;
        entry.down.disabled = !enabled || index === entries.length - 1;
        if (!enabled) entry.clearSuggestions();
      }
    }

    function move(entry, offset) {
      const from = entries.indexOf(entry), to = from + offset;
      if (!enabled || to < 0 || to >= entries.length) return;
      entry.clearSuggestions();
      [entries[from], entries[to]] = [entries[to], entries[from]];
      if (offset < 0) list.insertBefore(entry.row, entries[from].row);
      else list.insertBefore(entries[from].row, entry.row);
      sync();
      (offset < 0 && !entry.up.disabled ? entry.up : offset > 0 && !entry.down.disabled ? entry.down : entry.address).focus();
      onChange();
    }

    function addRow(saved, focus = true) {
      const id = prefix + '-' + ++serial;
      const row = node('fieldset'), legend = node('legend');
      row.className = 'booking-stop';
      const fields = node('div'), field = node('div'), waitingField = node('div');
      fields.className = 'booking-stop-fields';
      field.className = 'field booking-stop-address';
      waitingField.className = 'field';
      const addressLabel = node('label'), address = node('input'), suggestions = node('div');
      addressLabel.htmlFor = address.id = id + '-address';
      address.type = 'text';
      address.required = true;
      address.maxLength = 200;
      address.autocomplete = 'off';
      address.placeholder = 'Search for a stop address';
      address.value = saved?.address || '';
      suggestions.className = 'address-suggestions booking-stop-suggestions';
      field.append(addressLabel, address, suggestions);
      const waitLabel = node('label'), wait = node('select');
      waitLabel.htmlFor = wait.id = id + '-waiting';
      for (const minutes of waitOptions) {
        const option = node('option', minutes + ' minutes');
        option.value = String(minutes);
        wait.append(option);
      }
      if (waitOptions.includes(saved?.waitMinutes)) wait.value = String(saved.waitMinutes);
      waitingField.append(waitLabel, wait);
      const actions = node('div'), up = button('Move up'), down = button('Move down'), remove = button('Remove Stop');
      actions.className = 'booking-stop-actions';
      actions.append(up, down, remove);
      fields.append(field, waitingField);
      row.append(legend, fields, actions);
      list.append(row);

      let timer, lookup;
      function clearSuggestions() {
        clearTimeout(timer);
        lookup?.abort();
        lookup = null;
        suggestions.replaceChildren();
      }
      const entry = {row, legend, address, addressLabel, wait, waitLabel, up, down, remove,
        placeId: placeId.test(saved?.placeId || '') ? saved.placeId : '', clearSuggestions};
      entries.push(entry);

      address.addEventListener('input', () => {
        clearSuggestions();
        entry.placeId = '';
        address.setCustomValidity('');
        onChange();
        const query = address.value.trim();
        if (!enabled || query.length < 3) return;
        timer = setTimeout(async () => {
          const current = lookup = new AbortController();
          try {
            const response = await fetch('/api/address-suggestions?q=' + encodeURIComponent(query),
              {signal: current.signal, cache: 'no-store'});
            if (!response.ok) return;
            const data = await response.json();
            if (lookup !== current || address.value.trim() !== query || !row.isConnected) return;
            for (const item of (Array.isArray(data.suggestions) ? data.suggestions.slice(0, 6) : [])) {
              if (typeof item?.description !== 'string' || !placeId.test(item.placeId || '')) continue;
              const choice = button(item.description);
              choice.className = 'address-suggestion';
              choice.addEventListener('mousedown', event => event.preventDefault());
              choice.addEventListener('click', () => {
                address.value = item.description;
                address.setCustomValidity('');
                entry.placeId = item.placeId;
                clearSuggestions();
                address.focus();
                onChange();
              });
              suggestions.append(choice);
            }
          } catch (_) {}
        }, 300);
      });
      field.addEventListener('focusout', event => {
        if (!field.contains(event.relatedTarget)) clearSuggestions();
      });
      field.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
          address.focus();
          clearSuggestions();
        }
      });
      wait.addEventListener('change', onChange);
      up.addEventListener('click', () => move(entry, -1));
      down.addEventListener('click', () => move(entry, 1));
      remove.addEventListener('click', () => {
        if (!enabled) return;
        const index = entries.indexOf(entry);
        entries.splice(index, 1);
        clearSuggestions();
        row.remove();
        sync();
        (entries[index]?.address || entries.at(-1)?.address || add).focus();
        onChange();
      });
      sync();
      if (focus) address.focus();
    }

    add.addEventListener('click', () => {
      if (!enabled || entries.length >= 3) return;
      addRow();
      onChange();
    });

    return {
      setEnabled(value) {
        enabled = value;
        container.hidden = !enabled;
        sync();
      },
      values() {
        return enabled ? entries.map(entry => ({address: entry.address.value.trim(),
          placeId: entry.placeId, waitMinutes: Number(entry.wait.value)})) : [];
      },
      invalidAddress() {
        if (!enabled) return null;
        for (const entry of entries) {
          const valid = entry.address.value.trim() && placeId.test(entry.placeId);
          entry.address.setCustomValidity(valid ? '' : 'Select a stop address from the address suggestions.');
          if (!valid) return entry.address;
        }
        return null;
      },
      replace(stops = []) {
        for (const entry of entries) entry.clearSuggestions();
        entries.length = 0;
        list.replaceChildren();
        for (const stop of stops.slice(0, 3)) addRow(stop, false);
        sync();
      }
    };
  }

  function stopText(stop) {
    return stop.address + ' · ' + stop.plannedMinutes + ' min expected, ' +
      stop.freeMinutes + ' min free, ' + stop.billableMinutes + ' min billable';
  }

  function renderSummary(container, summary) {
    if (!container) return;
    container.replaceChildren();
    for (const stop of summary?.stops || []) {
      const row = node('div'), label = node('span', 'Stop ' + stop.sequence);
      const detail = node('div'), address = node('strong', stop.address);
      const wait = node('small', stop.plannedMinutes + ' min expected · ' +
        stop.freeMinutes + ' min free · ' + stop.billableMinutes + ' min billable');
      row.className = 'summary-row booked-stop-row';
      detail.append(address, wait);
      row.append(label, detail);
      container.append(row);
    }
    container.hidden = !container.childElementCount;
  }

  globalThis.BookingStops = {createEditor, stopText, renderSummary};
})();