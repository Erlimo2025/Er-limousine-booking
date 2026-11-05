'use strict';
// Seed a historical accepted, unsubmitted Pay Later fare. This is test setup,
// never a new-booking fallback or permission to reprice a real reservation.
module.exports=function legacyIncluded(record){
 if(record.stripeSessionId||record.paymentStatus==='paid'||record.checkoutAttempt?.firstSubmittedAt)throw Error('Requires an unsubmitted test reservation');
 const copy=structuredClone(record),q=copy.quote,old=q.tolls;
 q.originalTotal=(Math.round(q.originalTotal*100)-old.amountCents)/100;
 const t={...require('../../services/advance-toll-estimate').included(old.eligibility),...(old.pricingCategory?{pricingCategory:old.pricingCategory}:{})};
 require('../../services/route-tolls').attachTolls(q,t);
 return copy;
};
