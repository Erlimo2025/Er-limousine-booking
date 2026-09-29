/**
 * ER Limousine Service LLC
 * Production pricing
 *
 * All prices and promotions are calculated
 * on the server for security.
 */

module.exports = {
  currency: "usd",

  vehicleRates: {
    sedan: {
      label: "Luxury Sedan",
      baseFare: 20,
      perMile: 3,
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
  tollAllowance: 0,

  promotions: {
    FIRST15: {
      label: "First Ride 15% Off",
      percentOff: 15,
      firstRideOnly: true,
      active: true
    }
  }
};
