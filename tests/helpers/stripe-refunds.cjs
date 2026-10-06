// Isolated provider simulation: no Stripe network calls or genuine credentials.
function stripeRefundMock(state) {
 state.refunds ||= new Map();state.refundRequests ||= [];state.refundRetrievals ||= [];
 state.paymentIntentRequests ||= [];state.chargeRequests ||= [];
 const clone=x=>structuredClone(x);
 const missing=()=>{throw Object.assign(new Error('synthetic private missing payment'),{type:'StripeInvalidRequestError',code:'resource_missing'});};
 const sessionFor=id=>[...state.sessions.values()].find(s=>s.payment_intent===id);
 const chargeFor=id=>[...state.sessions.values()].find(s=>'ch_mock_'+s.payment_intent===id);
 const charge=s=>({id:'ch_mock_'+s.payment_intent,object:'charge',payment_intent:s.payment_intent,
  paid:s.payment_status==='paid',captured:s.payment_status==='paid',status:'succeeded',disputed:false,amount:s.amount_total,amount_captured:s.amount_total,
  amount_refunded:[...state.refunds.values()].filter(r=>r.charge==='ch_mock_'+s.payment_intent && r.status==='succeeded').reduce((sum,r)=>sum+r.amount,0),
  currency:s.currency,customer:s.customer,metadata:s.metadata,livemode:false,refunded:false});
 return {
  paymentIntents:{retrieve:async(id,params,options)=>{
   state.paymentIntentRequests.push({id,params:clone(params),options:clone(options)});
   if(state.paymentIntentError)throw new Error('synthetic private payment retrieval failure');
   const s=sessionFor(id);if(!s)missing();
   const pi={id,object:'payment_intent',status:s.payment_status==='paid'?'succeeded':'requires_payment_method',
    amount:s.amount_total,amount_received:s.payment_status==='paid'?s.amount_total:0,currency:s.currency,
    customer:s.customer,latest_charge:'ch_mock_'+id,metadata:s.metadata,livemode:false};
   return clone({...pi,...state.paymentIntentOverride});
  }},
  charges:{retrieve:async(id,params,options)=>{
   state.chargeRequests.push({id,params:clone(params),options:clone(options)});
   if(state.chargeError)throw new Error('synthetic private charge retrieval failure');
   const s=chargeFor(id);if(!s)missing();return clone({...charge(s),...state.chargeOverride});
  }},
  refunds:{
   create:async(params,options)=>{
    state.refundRequests.push({params:clone(params),options:clone(options)});
    if(state.refundOnCall)await state.refundOnCall('create',params,options);
    if(state.refundDelay)await new Promise(resolve=>setTimeout(resolve,state.refundDelay));
    if(state.refundError){const e=state.refundError;if(!state.persistentRefundError)state.refundError=null;throw e;}
    const prior=[...state.refunds.values()].find(r=>r.key===options.idempotencyKey);if(prior)return clone(prior);
    const s=params.payment_intent?sessionFor(params.payment_intent):chargeFor(params.charge);if(!s)missing();
    const r={id:'re_mock_'+state.refunds.size,object:'refund',payment_intent:s.payment_intent,
     charge:'ch_mock_'+s.payment_intent,amount:params.amount??s.amount_total,currency:s.currency,
     metadata:clone(params.metadata||{}),status:state.refundStatus||'succeeded',livemode:false,key:options.idempotencyKey};
    state.refunds.set(r.id,r);
    if(state.loseRefundResponse){state.loseRefundResponse=false;throw new Error('synthetic private lost refund response');}
    return clone({...r,...state.refundResponseOverride});
   },
   retrieve:async(id,params,options)=>{
    state.refundRetrievals.push({id,params:clone(params),options:clone(options)});
    if(state.refundRetrieveError)throw new Error('synthetic private refund retrieval failure');
    const r=state.refunds.get(id);if(!r)missing();return clone({...r,...state.refundResponseOverride});
   }
  }
 };
}
module.exports={stripeRefundMock};
