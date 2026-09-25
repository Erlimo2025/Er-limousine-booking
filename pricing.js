/**
 * ER Limousine Service LLC
 * Production pricing
 *
 * The server—not the browser—uses this file to calculate prices.
 * That prevents a customer from changing the fare in their browser.
 */

module.exports = {
  currency: "usd",

  vehicleRates: {
    sedan: {
      label: "Luxury Sedan",
      baseFare: 20,
      perMile: 4,
      perMinute: 1,
      minimumFare: 20,
      maxPassengers: 3
    },

    suv: {
      label: "Black SUV",
      baseFare: 20,
      perMile: 4,
      perMinute: 1,
      minimumFare: 20,
      maxPassengers: 6
    }
  },

  airportSurcharge: 0,
  lateNightSurcharge: 0,
  lateNightStartHour: 23,
  lateNightEndHour: 5,
  gratuityPercent: 0,

  tollAllowance: 0
};
