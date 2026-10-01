/**
 * ER Limousine Service LLC
 * Production pricing
 *
 * All prices, fixed offers and promotions
 * are calculated on the server for security.
 */

module.exports = {
  currency: "usd",

  vehicleRates: {
    escalade: {
      label: "Cadillac Escalade",
      baseFare: 30,
      perMile: 4.5,
      perMinute: 1.25,
      minimumFare: 30,
      maxPassengers: 6,
      maxLuggage: 6,
      hourlyRate: 150
    },

    suv: {
      label: "Black SUV",
      baseFare: 20,
      perMile: 4,
      perMinute: 1,
      minimumFare: 20,
      maxPassengers: 6,
      hourlyRate: 130
    }
  },

  airportSurcharge: 0,
  lateNightSurcharge: 0,
  lateNightStartHour: 23,
  lateNightEndHour: 5,
  gratuityPercent: 0,
  tollAllowance: 0,

  fixedOffers: {
    EWR_MANHATTAN_SUV: {
      label: "EWR to Manhattan Black SUV — $150 Flat Rate",
      price: 150,
      vehicle: "suv",
      active: true,
      allowPromotions: false
    }
  },

  promotions: {
    FIRST15: {
      label: "First Ride 15% Off",
      percentOff: 15,
      firstRideOnly: true,
      active: true
    }
  }
};
