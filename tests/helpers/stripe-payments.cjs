// Mock only: no network and no real card details.
function stripePaymentMock(state) {
 let p=state.payments ||= {customers:new Map(),setups:new Map(),cards:new Map(),keys:new Map(),calls:[]};
 const clone=x=>structuredClone(x);
 async function call(op,params,options,fn){p=state.payments;p.calls.push({op,params:clone(params),options:clone(options)});if(p.onCall)await p.onCall(op);if(p.delay)await new Promise(r=>setTimeout(r,p.delay));if(p.fail===op)throw Object.assign(new Error('synthetic private provider message'),{type:'StripeAPIError'});return fn();}
 const missing=()=>{throw Object.assign(new Error('synthetic private missing provider object'),{type:'StripeInvalidRequestError',code:'resource_missing'});};
 return {
  customers:{
   create:(params,options)=>call('createCustomer',params,options,()=>{
    const key=options.idempotencyKey;let c=p.keys.get(key);
    if(!c){c={id:'cus_saved'+(p.customers.size+1),livemode:false,metadata:params.metadata};p.customers.set(c.id,c);p.keys.set(key,c);}
    if(p.loseCustomer){p.loseCustomer=false;throw new Error('synthetic lost response');}return clone(c);
   }),
   listPaymentMethods:(customer,params,options)=>call('listCards',{customer,...params},options,()=>{
    if(p.listResult)return clone(p.listResult);
    const all=[...p.cards.values()].filter(x=>x.customer===customer && x.type==='card'),offset=params.starting_after?all.findIndex(x=>x.id===params.starting_after)+1:0;
    return {data:clone(all.slice(offset,offset+params.limit)),has_more:offset+params.limit<all.length};
   }),
   retrievePaymentMethod:(customer,id,params,options)=>call('ownedCard',{customer,id},options,()=>{const pm=p.cards.get(id);if(!pm||pm.customer!==customer)missing();return clone(pm);})
  },
  setupIntents:{
   create:(params,options)=>call('createSetup',params,options,()=>{
    const key=options.idempotencyKey;let si=p.keys.get(key);
    if(!si){const id='seti_saved'+(p.setups.size+1);si={id,customer:params.customer,livemode:false,status:'requires_payment_method',payment_method_types:params.payment_method_types,usage:params.usage,metadata:params.metadata,client_secret:id+'_secret_synthetic',payment_method:null};p.setups.set(id,si);p.keys.set(key,si);}
    if(p.loseSetup){p.loseSetup=false;throw new Error('synthetic lost response');}return clone(si);
   }),
   retrieve:(id,params,options)=>call('retrieveSetup',{id},options,()=>{if(!p.setups.has(id))missing();return clone(p.setups.get(id));}),
   cancel:(id,params,options)=>call('cancelSetup',{id},options,()=>{const si=p.setups.get(id);if(!si)missing();si.status='canceled';return clone(si);})
  },
  paymentMethods:{detach:(id,params,options)=>call('detach',{id},options,()=>{const pm=p.cards.get(id);if(!pm)missing();pm.customer=null;return clone(pm);})}
 };
}
module.exports={stripePaymentMock};
