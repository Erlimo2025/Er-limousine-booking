'use strict';
const reviews=require('../services/customer-reviews');
function installCustomerReviews(app,{store,route,rateLimit,requireAdmin,siteUrl,now=Date.now}){
 const origin=new URL(siteUrl).origin;
 const privateResponse=(req,res,next)=>{res.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Robots-Tag':'noindex, nofollow'});next();};
 const mutation=(req,res,next)=>{
  if(req.get('origin')!==origin || req.get('sec-fetch-site') && !['same-origin','none'].includes(req.get('sec-fetch-site')) || !req.is('application/json') || Object.keys(req.query).length || !req.body || typeof req.body!=='object' || Array.isArray(req.body))return res.status(403).json({error:'Invalid request.'});next();
 };
 const safe=handler=>route(async(req,res)=>{try{await handler(req,res);}catch(error){if(error.reviewSafe && [400,401,404,409,503].includes(error.status))return res.status(error.status).json({error:error.message});throw error;}});
 app.get('/review.html',privateResponse,(req,res,next)=>next());
 app.use('/api/reviews',privateResponse);
 app.post('/api/reviews/invitation',rateLimit('review-invitation',30),mutation,safe(async(req,res)=>{
  if(Object.keys(req.body).join(',')!=='token')throw reviews.invalidLink();
  if(!await store.reviewInvitation(reviews.tokenHash(req.body.token),now()))throw reviews.invalidLink();res.json({eligible:true});
 }));
 app.post('/api/reviews',rateLimit('review-submit',10),mutation,safe(async(req,res)=>{
  await store.submitCustomerReview({...reviews.reviewInput(req.body),now:now()});res.json({message:'Thank you for your feedback!'});
 }));
 app.get('/api/reviews/public',rateLimit('public-reviews',60),safe(async(req,res)=>res.json(await store.listCustomerReviews(reviews.pageQuery(req.query,true,now())))));
 app.get('/api/admin/reviews',requireAdmin,rateLimit('admin-reviews',60),safe(async(req,res)=>res.json(await store.listCustomerReviews(reviews.pageQuery(req.query,false,now()),req.adminArchiveAuthority))));
 app.post('/api/admin/reviews/:id/moderate',requireAdmin,rateLimit('review-moderate',30),mutation,safe(async(req,res)=>{
  const input=reviews.moderationInput(req.params.id,req.body);res.json(await store.moderateCustomerReview(req.adminArchiveAuthority,req.params.id,input,now()));
 }));
 app.get('/api/admin/reviews/:id/history',requireAdmin,rateLimit('review-history',30),safe(async(req,res)=>{
  if(!reviews.uuid.test(req.params.id) || Object.keys(req.query).length)throw reviews.fail(400,'Invalid review reference.');res.json({events:await store.customerReviewHistory(req.adminArchiveAuthority,req.params.id)});
 }));
}
module.exports={installCustomerReviews};
