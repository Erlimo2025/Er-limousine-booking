const crypto=require('node:crypto');
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const providerId=(value,prefix)=>typeof value==='string' && new RegExp('^'+prefix+'_[A-Za-z0-9_]{1,120}$').test(value);
function paymentError(status=503){return Object.assign(new Error('Payment methods are temporarily unavailable. Please try again.'),{paymentFailure:true,status});}
const reference=value=>typeof value==='string'?value:value?.id;
// Only SDK request options are passed through. Provider errors/payloads never reach the logger.
function stripePaymentProvider(stripe) {
 const options={timeout:8000,maxNetworkRetries:0};
 async function call(fn,missing=false){try{return await fn();}catch(error){if(missing && error?.type==='StripeInvalidRequestError' && error?.code==='resource_missing')return null;throw paymentError();}}
 return {
  createCustomer:(id)=>call(()=>stripe.customers.create({metadata:{paymentMappingReference:id}},{...options,idempotencyKey:'er-saved-customer-v1-'+id})),
  createSetup:(customer,attempt)=>call(()=>stripe.setupIntents.create({customer,payment_method_types:['card'],usage:'on_session',metadata:{setupReference:attempt}},{...options,idempotencyKey:'er-saved-setup-v1-'+attempt})),
  retrieveSetup:id=>call(()=>stripe.setupIntents.retrieve(id,{},options)),
  cancelSetup:(id,attempt)=>call(()=>stripe.setupIntents.cancel(id,{}, {...options,idempotencyKey:'er-saved-cancel-v1-'+attempt})),
  listCards:(customer,limit,cursor)=>call(()=>stripe.customers.listPaymentMethods(customer,{type:'card',limit,...(cursor?{starting_after:cursor}:{})},options)),
  ownedCard:(customer,id)=>call(()=>stripe.customers.retrievePaymentMethod(customer,id,{},options),true),
  detach:(id,customer)=>call(()=>stripe.paymentMethods.detach(id,{}, {...options,idempotencyKey:'er-saved-detach-v1-'+crypto.createHash('sha256').update(customer+'|'+id).digest('hex')}),true)
 };
}
function customerPayments({store,provider,now=Date.now}) {
 const authority=auth=>store.paymentAuthority(auth.id,auth.sessionHash,now());
 const lock=(auth,fn)=>store.withActionLock('customer-payment-methods:'+auth.id,fn);
 const elapsed=timestamp=>now()-new Date(timestamp).getTime();
 const validMapping=m=>m?.state==='ready' && providerId(m.stripe_customer_id,'cus') && typeof m.livemode==='boolean';
 async function mapping(auth) {
  let m=await store.preparePaymentMapping(auth.id,auth.sessionHash,now());
  if(m.state==='ready'){if(!validMapping(m))throw paymentError();return m;}
  if(m.state==='review_required')throw paymentError();
  if(m.first_submitted_at && elapsed(m.first_submitted_at)>=23*3600000){await store.updatePaymentMapping(auth.id,auth.sessionHash,m,'review_required',now());throw paymentError();}
  m=await store.updatePaymentMapping(auth.id,auth.sessionHash,m,'submitted_unknown',now());
  const result=await provider.createCustomer(m.provisioning_id);
  if(!providerId(result?.id,'cus') || typeof result.livemode!=='boolean' || result.deleted || result.metadata?.paymentMappingReference!==m.provisioning_id)throw paymentError();
  return store.updatePaymentMapping(auth.id,auth.sessionHash,m,'ready',now(),{id:result.id,livemode:result.livemode});
 }
 function checkSetup(si,m,a) {
  if(!providerId(si?.id,'seti') || si.id!==a.stripe_setup_id || reference(si.customer)!==m.stripe_customer_id || si.livemode!==m.livemode || si.usage!=='on_session' ||
     !Array.isArray(si.payment_method_types) || si.payment_method_types.length!==1 || si.payment_method_types[0]!=='card' || si.metadata?.setupReference!==a.id ||
     !['requires_payment_method','requires_confirmation','requires_action','processing','succeeded','canceled'].includes(si.status))throw paymentError();
 }
 const ownedCard=(pm,m)=>pm?.type==='card' && reference(pm.customer)===m.stripe_customer_id && pm.livemode===m.livemode && providerId(pm.id,'pm');
 async function completed(si,m,allowMissing=false) {
  if(si.status!=='succeeded' || !providerId(reference(si.payment_method),'pm'))throw paymentError(409);
  const pm=await provider.ownedCard(m.stripe_customer_id,reference(si.payment_method));
  // A customer-scoped missing result cannot save a card, but can retire an old completed attempt.
  if(pm===null && allowMissing)return false;
  if(!ownedCard(pm,m) || pm.id!==reference(si.payment_method))throw paymentError();
  return true;
 }
 return {
  // Internal Checkout integration: never accepts a provider customer from the browser.
  checkoutCustomer:auth=>lock(auth,async()=>{
   await authority(auth);const m=await mapping(auth);await authority(auth);return m.stripe_customer_id;
  }),
  setup:auth=>lock(auth,async()=>{
   await authority(auth);const m=await mapping(auth);
   // At most one existing attempt is reconciled before creating/reusing its replacement.
   for(let pass=0;pass<2;pass++){
   let a=await store.preparePaymentSetup(auth.id,auth.sessionHash,now());
   if(a.state==='review_required')throw paymentError();
   if(!a.stripe_setup_id && !a.first_submitted_at && elapsed(a.expires_at)>=0){
    await store.updatePaymentSetup(auth.id,auth.sessionHash,a,'cancelled',now());continue;
   }
   let si;
   if(a.stripe_setup_id){si=await provider.retrieveSetup(a.stripe_setup_id);checkSetup(si,m,a);}
   else {
    if(a.first_submitted_at && elapsed(a.first_submitted_at)>=23*3600000){await store.updatePaymentSetup(auth.id,auth.sessionHash,a,'review_required',now());throw paymentError();}
    // Persist uncertainty before the network call. Retries always use the same attempt.
    a=await store.updatePaymentSetup(auth.id,auth.sessionHash,a,'submitted_unknown',now());
    si=await provider.createSetup(m.stripe_customer_id,a.id);
    if(!providerId(si?.id,'seti'))throw paymentError();
    checkSetup(si,m,{...a,stripe_setup_id:si.id});
    a=await store.updatePaymentSetup(auth.id,auth.sessionHash,a,'identified',now(),si.id);
   }
   if(si.status==='succeeded'){
    const saved=await completed(si,m,true);
    await store.updatePaymentSetup(auth.id,auth.sessionHash,a,saved?'succeeded':'cancelled',now());continue;
   }
   if(si.status==='canceled'){await store.updatePaymentSetup(auth.id,auth.sessionHash,a,'cancelled',now());continue;}
   if(elapsed(a.expires_at)>=0){
    // Known abandoned setups can be canceled conclusively; processing remains blocked.
    if(['requires_payment_method','requires_confirmation','requires_action'].includes(si.status)){
     const canceled=await provider.cancelSetup(si.id,a.id);checkSetup(canceled,m,a);
     if(canceled.status!=='canceled')throw paymentError();
     await store.updatePaymentSetup(auth.id,auth.sessionHash,a,'cancelled',now());
     continue;
    }
    throw paymentError(409);
   }
   if(si.status==='processing')throw paymentError(409);
   await authority(auth);
   if(typeof si.client_secret!=='string' || si.client_secret.length>512 || !si.client_secret.startsWith(si.id+'_secret_'))throw paymentError();
   return {attempt:a.id,clientSecret:si.client_secret};
   }
   throw paymentError(409);
  }),
  verify:(auth,id)=>lock(auth,async()=>{
   if(!uuid.test(id))throw paymentError(404);
   await authority(auth);const a=await store.paymentSetup(auth.id,id),m=await store.paymentMapping(auth.id);
   if(!a || !a.stripe_setup_id || a.state==='cancelled')throw paymentError(404);
   if(!validMapping(m))throw paymentError();
   const si=await provider.retrieveSetup(a.stripe_setup_id);checkSetup(si,m,a);
   if(si.status==='canceled' || (elapsed(a.expires_at)>=0 && ['requires_payment_method','requires_confirmation','requires_action'].includes(si.status))){
    // Retire only after Stripe conclusively confirms cancellation; processing stays retryable.
    if(si.status!=='canceled'){const canceled=await provider.cancelSetup(si.id,a.id);checkSetup(canceled,m,a);if(canceled.status!=='canceled')throw paymentError();}
    await store.updatePaymentSetup(auth.id,auth.sessionHash,a,'cancelled',now());throw paymentError(404);
   }
   if(si.status!=='succeeded')throw paymentError(409);
   if(!await completed(si,m,true)){await store.updatePaymentSetup(auth.id,auth.sessionHash,a,'cancelled',now());throw paymentError(404);}
   if(a.state!=='succeeded')await store.updatePaymentSetup(auth.id,auth.sessionHash,a,'succeeded',now());else await authority(auth);
   return {ok:true};
  }),
  list:async(auth,limit,cursor)=>{
   const m=await store.paymentMapping(auth.id);if(!m)return {cards:[],next:null};if(!validMapping(m))throw paymentError();
   if(cursor){const pm=await provider.ownedCard(m.stripe_customer_id,cursor);if(!ownedCard(pm,m)||pm.id!==cursor)throw paymentError(400);}
   const result=await provider.listCards(m.stripe_customer_id,limit,cursor);
   if(!Array.isArray(result?.data) || result.data.length>limit || typeof result.has_more!=='boolean')throw paymentError();
   const cards=result.data.map(pm=>{
    if(!ownedCard(pm,m) || typeof pm.card?.brand!=='string' || !['amex','diners','discover','eftpos_au','jcb','mastercard','unionpay','visa','unknown'].includes(pm.card.brand) ||
       typeof pm.card.last4!=='string' || !/^\d{4}$/.test(pm.card.last4) || !Number.isInteger(pm.card.exp_month) || pm.card.exp_month<1 || pm.card.exp_month>12 || !Number.isInteger(pm.card.exp_year) || pm.card.exp_year<2000 || pm.card.exp_year>2200)throw paymentError();
    return {id:pm.id,brand:pm.card.brand,last4:pm.card.last4,expMonth:pm.card.exp_month,expYear:pm.card.exp_year};
   });
   await authority(auth);return {cards,next:result.has_more && cards.length ? cards.at(-1).id : null};
  },
  remove:(auth,id)=>lock(auth,async()=>{
   await authority(auth);const m=await store.paymentMapping(auth.id);if(!m)return {ok:true};if(!validMapping(m))throw paymentError();
   const pm=await provider.ownedCard(m.stripe_customer_id,id);
   // Foreign/missing/detached cards all produce the same harmless result.
   if(!ownedCard(pm,m) || pm.id!==id)return {ok:true};
   await authority(auth);const result=await provider.detach(id,m.stripe_customer_id);
   if(result && (result.id!==id || result.customer!==null))throw paymentError();return {ok:true};
  })
 };
}
module.exports={customerPayments,stripePaymentProvider,paymentError,providerId,uuid};
