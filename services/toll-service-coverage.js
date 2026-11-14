'use strict';

const {covered} = require('./advance-toll-estimate');

const POLICY = 'eligible_us_routes_v1';
const LEGACY_POLICY = 'interstate_only';
const states = new Set('AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' '));
const placeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,255}$/.test(value);

// NYS Department of Health county directory (excluding NYC, which uses covered()).
const otherNyCounties = new Set((
  'Albany Allegany Broome Cattaraugus Cayuga Chautauqua Chemung Chenango Clinton Columbia Cortland Delaware Dutchess Erie Essex Franklin Fulton Genesee Greene Hamilton Herkimer Jefferson Lewis Livingston Madison Monroe Montgomery Nassau Niagara Oneida Onondaga Ontario Orange Orleans Oswego Otsego Putnam Rensselaer Rockland Saratoga Schenectady Schoharie Schuyler Seneca Steuben Suffolk Sullivan Tioga Tompkins Ulster Warren Washington Wayne Westchester Wyoming Yates'
).split(' ').map(county=>county+' County').concat('St. Lawrence County'));

// Only a verified NY destination county can resolve an NJ-to-NY toll decision.
function chargeableLeg(from, to) {
  if (from.state !== 'NJ' || to.state !== 'NY') return false;
  if (covered(to, to)) return true;
  return otherNyCounties.has(to.county) ? false : null;
}

// Validate the recorded scope independently of any live configuration.
function validEligibility(eligibility) {
  if (!eligibility || typeof eligibility !== 'object' || Array.isArray(eligibility) ||
      !states.has(eligibility.pickupState) || !states.has(eligibility.dropoffState) ||
      !placeId(eligibility.pickupPlaceId) || !placeId(eligibility.dropoffPlaceId)) return false;
  if (eligibility.policy === LEGACY_POLICY) return true;
  if (eligibility.policy !== POLICY || eligibility.pickupPlaceId === eligibility.dropoffPlaceId) return false;
  const withinCore = covered({state:eligibility.pickupState, county:eligibility.pickupCounty},
    {state:eligibility.dropoffState, county:eligibility.dropoffCounty});
  return eligibility.serviceScope === (withinCore ? 'nj_nyc_five_boroughs' : 'operator_approved_state_lane');
}

module.exports = {POLICY, LEGACY_POLICY, states, validEligibility, chargeableLeg};
