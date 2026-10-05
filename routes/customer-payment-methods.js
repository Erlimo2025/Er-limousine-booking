const {customerPayments,stripePaymentProvider,paymentError,providerId,uuid}=require('../services/customer-payments');
function installCustomerPaymentMethods(app,{store,stripe,customerAuth,route,enabled,siteUrl,production=false,clientKey,reportFailure,now=Date.now}) {
 const base='/api/customer/payment-methods';
 const service=stripe?customerPayments({store,provider:stripePaymentProvider(stripe),now}):null;
 let configured=false;
 try{const site=new URL(siteUrl);configured=!!service && !site.username && !site.password && !site.search && !site.hash && ['http:','https:'].includes(site.protocol) && (!production || site.protocol==='https:');}catch(_){}
 const unavailable=(req,res,status=503)=>res.status(status).json({error:`Payment methods are temporarily unavailable. Please try again. Reference: ${req.referenceId}`});
 const send=async(req,res,operation,fn)=>{
  try{
   if(!await store.paymentLimit(req.customer.id,clientKey(req),operation,now()))throw paymentError(429);
   await fn({id:req.customer.id,sessionHash:req.customerSessionHash});
  }catch(error){
   const status=error?.paymentFailure && [400,401,404,409,429,503].includes(error.status)?error.status:error?.status===409?409:503;
   reportFailure(req,status,error?.storageFailure?'postgresql':'stripe');
   if(status===404)return res.status(404).json({error:'Payment method setup unavailable.'});
   if(status===401)return res.status(401).json({error:'Please log in to continue.'});
   unavailable(req,res,status);
  }
 };
 app.use(base,(req,res,next)=>{res.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer'});next();});
 // Keep the full API path visible to the existing session middleware (401, not a page redirect).
 app.use((req,res,next)=>req.path===base || req.path.startsWith(base+'/')?route(customerAuth.requireCustomer)(req,res,next):next());
 app.use(base,(req,res,next)=>{
  if(!enabled || !configured){reportFailure(req,503,'stripe');return unavailable(req,res);}next();
 });
 const mutation=(req,res,next)=>{
  let origin;try{origin=new URL(siteUrl).origin;}catch(_){return unavailable(req,res);}
  if(req.get('origin')!==origin || (req.get('sec-fetch-site') && !['same-origin','none'].includes(req.get('sec-fetch-site'))) || !req.is('application/json'))return res.status(403).json({error:'Invalid request.'});
  if(!req.body || Array.isArray(req.body) || typeof req.body!=='object')return res.status(400).json({error:'Invalid request.'});next();
 };
 const empty=(req,res,next)=>Object.keys(req.body).length?res.status(400).json({error:'Invalid request.'}):next();
 app.post(base+'/setup',mutation,route(async(req,res)=>{
  if(Object.keys(req.body).length!==1 || req.body.consent!==true)return res.status(400).json({error:'Consent is required to save a card.'});
  return send(req,res,'setup',async auth=>res.json(await service.setup(auth)));
 }));
 app.post(base+'/setup/:attempt/verify',mutation,empty,route(async(req,res)=>{
  if(!uuid.test(req.params.attempt))return res.status(404).json({error:'Payment method setup unavailable.'});
  return send(req,res,'verify',async auth=>res.json(await service.verify(auth,req.params.attempt)));
 }));
 app.get(base,route(async(req,res)=>{
  if(Object.keys(req.query).some(key=>!['limit','cursor'].includes(key)) || (req.query.limit!==undefined && (typeof req.query.limit!=='string' || !/^(?:[1-9]|[1-4][0-9]|50)$/.test(req.query.limit))) ||
     (req.query.cursor!==undefined && !providerId(req.query.cursor,'pm')))return res.status(400).json({error:'Invalid request.'});
  return send(req,res,'list',async auth=>{const result=await service.list(auth,Number(req.query.limit || 20),req.query.cursor);if(result.next)res.set('X-Payment-Methods-Next',result.next);res.json(result.cards);});
 }));
 app.delete(base+'/:id',mutation,empty,route(async(req,res)=>{
  if(!providerId(req.params.id,'pm'))return res.status(400).json({error:'Invalid request.'});
  return send(req,res,'remove',async auth=>res.json(await service.remove(auth,req.params.id)));
 }));
}
module.exports={installCustomerPaymentMethods};
