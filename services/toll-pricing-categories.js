'use strict';
// A customer pricing model. Nothing in this module establishes an actual
// vehicle's eligibility, tag status, commercial rate or daily congestion history.
const ID='luxury_suv',POLICY='nj-ezpass-class1-advance-2026-v1',BASIS='operator_approved_customer_estimate';
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const njPass=passes=>Array.isArray(passes)&&passes.length===1&&passes[0]==='US_NJ_EZPASSNJ';
function validSnapshot(p){
 return plain(p)&&p.id===ID&&p.policy===POLICY&&p.basis===BASIS&&
  ['GASOLINE','DIESEL','ELECTRIC','HYBRID'].includes(p.emissionType)&&njPass(p.tollPasses)&&
  p.portAuthorityTariffClass==='1'&&p.congestionPlan==='standard_daily'&&
  ['eligible_peak','none'].includes(p.crossingCreditAssumption)&&
  p.actualVehicleEligibilityVerified===false&&p.companyAbsorbsDifferences===true;
}
function validProfile(profile){
 return plain(profile)&&validSnapshot(profile.customerEstimate)&&profile.verified===false&&
  profile.commercialRatesVerified===false&&profile.congestionCoverageVerified===false&&
  profile.official===undefined&&profile.estimate===undefined&&
  profile.emissionType===profile.customerEstimate.emissionType&&njPass(profile.tollPasses);
}
function resolve(pricing,vehicle){
 const rate=plain(pricing?.vehicleRates)&&Object.hasOwn(pricing.vehicleRates,vehicle)?pricing.vehicleRates[vehicle]:null;
 if(!plain(rate)||!Object.hasOwn(rate,'tollPricingCategory'))return {assigned:false,profile:null};
 const categories=pricing.tollPricingCategories;
 const p=rate.tollPricingCategory===ID&&plain(categories)&&Object.hasOwn(categories,ID)?categories[ID]:null;
 // An assigned but invalid category must not silently fall back to a different
 // vehicle's profile or to a client-supplied class/category claim.
 if(!plain(p)||p.operatorApprovedEstimate!==true||p.verified===true||p.actualVehicleEligibilityVerified===true||
  p.commercialRatesVerified===true||p.congestionCoverageVerified===true)return {assigned:true,profile:null};
 const model={id:ID,policy:p.policy,basis:BASIS,emissionType:p.emissionType,
  tollPasses:Array.isArray(p.tollPasses)?[...p.tollPasses]:p.tollPasses,
  portAuthorityTariffClass:p.portAuthorityTariffClass,congestionPlan:p.congestionPlan,
  crossingCreditAssumption:p.crossingCreditAssumption,actualVehicleEligibilityVerified:false,
  companyAbsorbsDifferences:p.companyAbsorbsDifferences};
 if(!validSnapshot(model))return {assigned:true,profile:null};
 return {assigned:true,profile:{emissionType:model.emissionType,tollPasses:[...model.tollPasses],verified:false,
  commercialRatesVerified:false,congestionCoverageVerified:false,customerEstimate:model}};
}
function snapshot(profile){return validProfile(profile)?{...profile.customerEstimate,tollPasses:[...profile.customerEstimate.tollPasses]}:null;}
module.exports={ID,POLICY,resolve,validSnapshot,validProfile,snapshot};
