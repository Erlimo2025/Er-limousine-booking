/**
 * TEMPORARY $5 PAYMENT TEST
 * ER Limousine Service LLC
 *
 * This pricing is ONLY being used to test the live Stripe
 * payment and webhook connection.
 */

module.exports = {
  currency: "usd",

  vehicleRates: {
    sedan: {
      label: "Luxury Sedan",
      baseFare: 5,
      perMile: 0,
      perMinute: 0,
      minimumFare: 5,
      maxPassengers: 3
    },

    suv: {
      label: "Black SUV",
      baseFare: 5,
      perMile: 0,
      perMinute: 0,
      minimumFare: 5,
      maxPassengers: 6
    },

    sprinter: {
      label: "Executive Sprinter",
      baseFare: 5,
      perMile: 0,
      perMinute: 0,
      minimumFare: 5,
      maxPassengers: 12
    }
  },

  airportSurcharge: 0,
  lateNightSurcharge: 0,
  lateNightStartHour: 23,
  lateNightEndHour: 5,
  gratuityPercent: 0,

  tollAllowance: 0
};
