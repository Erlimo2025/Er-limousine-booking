/**
 * Edit these numbers before launch.
 * The server—not the browser—uses this file to calculate prices.
 * That prevents a customer from changing the fare in their browser.
 */
module.exports = {
  currency: "usd",
  vehicleRates: {
    sedan: {
      label: "Luxury Sedan",
      baseFare: 25,
      perMile: 3.00,
      perMinute: 0.65,
      minimumFare: 85,
      maxPassengers: 3
    },
    suv: {
      label: "Black SUV",
      baseFare: 35,
      perMile: 4.25,
      perMinute: 0.80,
      minimumFare: 110,
      maxPassengers: 6
    },
    sprinter: {
      label: "Executive Sprinter",
      baseFare: 75,
      perMile: 5.75,
      perMinute: 1.10,
      minimumFare: 225,
      maxPassengers: 12
    }
  },
  airportSurcharge: 12,
  lateNightSurcharge: 20,
  lateNightStartHour: 23,
  lateNightEndHour: 5,
  gratuityPercent: 0,

  // Optional toll estimate. Keep 0 if you prefer to quote tolls separately.
  tollAllowance: 0
};
