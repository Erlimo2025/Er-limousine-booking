(() => {
  'use strict';

  function stopText(stop) {
    return stop.address + ' · ' + stop.plannedMinutes + ' min expected, ' +
      stop.freeMinutes + ' min free, ' + stop.billableMinutes + ' min billable';
  }

  globalThis.BookingStops = {stopText};
})();
