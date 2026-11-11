'use strict';
const crypto=require('node:crypto');
const {createBookingEmails}=require('./booking-emails');
const INVITATION_TTL=30*24*3600000;
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const tokenPattern=/^[A-Za-z0-9_-]{43}$/;
const fail=(status,message='Review unavailable. Please refresh and try again.')=>Object.assign(new Error(message),{status,reviewSafe:true});
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const invalidLink=()=>fail(400,'This review link is invalid, expired, or unavailable.');
function reviewPrivacy(comment){
 // Conservative local heuristics, not a guarantee of anonymity. Only reason
 // labels leave this function; never log or return matched sensitive values.
 if(typeof comment!=='string' || comment.length>2000)return {blocked:true,reasons:['unrecognized comment content']};
 const text=comment.normalize('NFKC').replace(/[\u200b-\u200d\u2060\ufeff]/g,'')
  .replace(/\s*[[(]\s*at\s*[\])]\s*/gi,'@').replace(/\s*[[(]\s*dot\s*[\])]\s*/gi,'.')
  .replace(/%([0-7][0-9a-f])/gi,(_,hex)=>String.fromCharCode(parseInt(hex,16)))
  .replace(/&(?:commat|#64|#x40);/gi,'@').replace(/&(?:period|#46|#x2e);/gi,'.');
 const reasons=[];
 if(/[\p{L}\p{N}._%+-]+\s*@\s*[\p{L}\p{N}-]+(?:\s*\.\s*[\p{L}\p{N}-]+)+/u.test(text))reasons.push('email address');
 if(/\b(?:https?|ftp|mailto|tel|sms|facetime|whatsapp|signal|tg):|(?:^|\s)\/\/|\bwww\s*\.|(?:^|\s)@[a-z0-9_]{3,32}\b/i.test(text) || /\b(?:[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?\.)+(?:com|net|org|edu|gov|mil|int|info|biz|me|io|app|dev|ai|co|us|uk|ca|test|example|[a-z]{2})(?:\b|\/)/i.test(text))reasons.push('contact link or handle');
 const numbers=text.match(/\+?(?:\(\d{1,4}\)|\d)[\d\s().-]{4,70}\d/g) || [];
 if(numbers.some(value=>{const clean=value.trim(),digits=clean.replace(/\D/g,'');return digits.length>=7 && !/^(?:\d{4}[-.]\d{1,2}[-.]\d{1,2}|\d{1,2}[ .-]\d{1,2}[ .-]\d{4})$/.test(clean);}))reasons.push('phone number or long numeric identifier');
 if(/\b(?:ER-[0-9]{6}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i.test(text) || /\b(?:cs_(?:live_|test_)?|pi_|pm_|seti_|cus_|ch_|re_|(?:sk|rk)_(?:live|test)_|whsec_)[a-z0-9_]{6,}\b/i.test(text) || /(?:^|[^a-z0-9_-])[a-z0-9_-]{40,}(?=$|[^a-z0-9_-])/i.test(text) || /\beyJ[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+\b/i.test(text))reasons.push('private reference or credential');
 if(/\b(?:ssn|social\s+security(?:\s+(?:number|no))?|(?:passport|license|licence|tax|patient|medical\s+record|routing|bank\s+account|account|credit\s+card|debit\s+card|license\s+plate|licence\s+plate)(?:\s+(?:number|no|id))?|driver'?s?\s+licen[cs]e|date\s+of\s+birth|dob|booking\s+(?:id|reference|number)|reservation\s+(?:id|reference|number))\b\s*(?:is\b|[:#=-])?\s*(?=[a-z0-9/_-]{0,40}\d)[a-z0-9/_-]{2,41}\b/i.test(text) || /\b(?:date\s+of\s+birth|dob|born\s+on)\b[^.\n]{0,30}\d/i.test(text) || /\b(?:reservation|booking|confirmation|license\s+plate|licence\s+plate)\s*(?:id|reference|ref|number|no|#)\s*(?:[:#=-]|is\b)?\s*[a-z0-9][a-z0-9_-]{3,63}\b/i.test(text) || /\b[a-z]{2}\d{2}(?: ?[a-z0-9]){11,30}\b/i.test(text))reasons.push('personal, financial or reservation identifier');
 if(/\b\d{1,6}\s+(?:[\p{L}\p{N}.'’-]+\s+){0,6}(?:street|st|avenue|ave|road|rd|lane|ln|drive|dr|court|ct|boulevard|blvd|place|pl|terrace|ter|way|parkway|pkwy)\b/iu.test(text))reasons.push('street address');
 return {blocked:reasons.length>0,reasons};
}
function requirePublicationPrivacy(comment){if(reviewPrivacy(comment).blocked)throw fail(409,'Publication blocked for privacy. Keep this review private; its original comment and rating cannot be edited or overridden.');}
function tokenHash(raw){if(typeof raw!=='string'||!tokenPattern.test(raw))throw invalidLink();return hash(raw);}
function reviewInput(body){
 if(!body || Array.isArray(body) || Object.keys(body).some(k=>!['token','rating','comment'].includes(k)) || !Number.isInteger(body.rating) || body.rating<1 || body.rating>5)throw fail(400,'Select a rating from 1 to 5 stars.');
 if(body.comment!==undefined && typeof body.comment!=='string')throw fail(400,'Enter a plain-text review of up to 2,000 characters.');
 const comment=(body.comment || '').replace(/\r\n?/g,'\n').trim();
 if(comment.length>2000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(comment) || /<\/?[a-z!][^>]*>/i.test(comment))throw fail(400,'Enter a plain-text review of up to 2,000 characters.');
 return {tokenHash:tokenHash(body.token),rating:body.rating,comment};
}
function displayName(customer){
 const first=String(customer.firstName || '').trim(),last=String(customer.lastName || '').trim();
 return /^[\p{L}\p{M}][\p{L}\p{M}'’ -]{0,38}$/u.test(first) && /^[\p{L}\p{M}]/u.test(last)?first+' '+[...last][0].toLocaleUpperCase('en-US')+'.':'Anonymous';
}
function moderationInput(id,body){
 if(!uuid.test(id) || !body || Array.isArray(body) || Object.keys(body).sort().join(',')!=='action,confirmed,reason,requestId,version' || !uuid.test(body.requestId) || !Number.isSafeInteger(body.version) || body.version<0 || body.version>1000000 || typeof body.confirmed!=='boolean' || !['publish','hold','remove'].includes(body.action))throw fail(400,'Invalid moderation request.');
 const reasons=body.action==='publish'?['authentic_feedback']:['spam','authenticity','privacy','inappropriate_content','customer_request'];
 if(!reasons.includes(body.reason) || ['publish','remove'].includes(body.action) && body.confirmed!==true)throw fail(400,'Confirm the action and choose an appropriate moderation reason.');
 return body;
}
function pageQuery(raw,publicView,now){
 const allowed=publicView?['limit','cursor']:['limit','cursor','status'];
 if(Object.keys(raw).some(k=>!allowed.includes(k)) || Object.values(raw).some(v=>typeof v!=='string'))throw fail(400,'Invalid review filters.');
 const limit=raw.limit===undefined?(publicView?6:20):Number(raw.limit),status=publicView?'published':raw.status || 'pending';
 if(!Number.isInteger(limit) || limit<1 || limit>(publicView?10:50) || !['pending','published','held'].includes(status))throw fail(400,'Invalid review filters.');
 let cursor=null,at=new Date(now).toISOString();
 if(raw.cursor){
  try{if(raw.cursor.length>800 || !/^[A-Za-z0-9_-]+$/.test(raw.cursor))throw Error();cursor=JSON.parse(Buffer.from(raw.cursor,'base64url').toString());
   if(Object.keys(cursor).sort().join(',')!=='at,id,limit,status,time' || !uuid.test(cursor.id) || cursor.status!==status || cursor.limit!==limit || !Number.isFinite(Date.parse(cursor.at)) || !Number.isFinite(Date.parse(cursor.time)) || new Date(cursor.at).toISOString()!==cursor.at || new Date(cursor.time).toISOString()!==cursor.time || cursor.at>at || cursor.time>cursor.at)throw Error();at=cursor.at;
  }catch(_){throw fail(400,'Invalid review page.');}
 }
 return {status,limit,at,cursor,publicView};
}
function reviewPage(rows,q){
 const page=rows.slice(0,q.limit),last=page.at(-1),time=q.publicView?'published_at':'submitted_at';
 return {reviews:page.filter(r=>!q.publicView || !reviewPrivacy(r.comment).blocked).map(r=>q.publicView?{id:r.id,rating:r.rating,comment:r.comment,displayName:r.display_name}:{id:r.id,customerName:r.customer_name,rating:r.rating,comment:r.comment,reservationReference:r.booking_id,submittedAt:new Date(r.submitted_at).toISOString(),status:r.status,version:r.version,privacyBlocked:reviewPrivacy(r.comment).blocked,privacyReasons:reviewPrivacy(r.comment).reasons}),
  nextCursor:rows.length>q.limit?Buffer.from(JSON.stringify({at:q.at,id:last.id,time:new Date(last[time]).toISOString(),limit:q.limit,status:q.status})).toString('base64url'):null};
}
const PUBLIC_REVIEW_SCAN_LIMIT=200;
function publicReviewPage(rows,q){
 const scanned=rows.slice(0,PUBLIC_REVIEW_SCAN_LIMIT),safe=scanned.filter(row=>!reviewPrivacy(row.comment).blocked),result=reviewPage(safe,q);
 // Consume filtered rows as well: a flagged older publication must not leak or
 // break keyset pagination. Bound both DB reads and in-process screening.
 if(!result.nextCursor && rows.length>PUBLIC_REVIEW_SCAN_LIMIT){const last=scanned.at(-1);result.nextCursor=Buffer.from(JSON.stringify({at:q.at,id:last.id,time:new Date(last.published_at).toISOString(),limit:q.limit,status:q.status})).toString('base64url');}
 return result;
}
function invitationToken(secret,row){return crypto.createHmac('sha256',secret).update('er-review-invitation/v1\0'+row.id+'\0'+row.booking_id).digest('base64url');}
function reviewInvitations({store,provider,siteUrl,secret,now=Date.now,reportFailure=()=>{}}){
 // A random invitation UUID plus a separate 256-bit key produces an unpredictable,
 // reservation-bound token. Only its hash is persisted; the link is rebuilt in RAM
 // for the exact same provider-idempotent message after a worker restart.
 let key=null,origin=null;
 try{if(typeof secret!=='string' || !tokenPattern.test(secret))throw Error();key=Buffer.from(secret,'base64url');if(key.length!==32 || key.toString('base64url')!==secret)throw Error();const u=new URL(siteUrl);if(u.username || u.password || u.protocol!=='https:' && !(u.protocol==='http:' && ['localhost','127.0.0.1','[::1]'].includes(u.hostname)))throw Error();origin=u.origin;}catch(_){key=null;}
 const enabled=!!key && !!provider?.enabled;
 const hashes=new Map();
 const queue=createBookingEmails({store:{
  claimBookingEmail:async time=>{
   let row;for(let i=0;i<10;i++){row=await store.claimReviewInvitation(time);if(!row || row.reviewRequired)return row;if(!row.skip)break;row=null;}if(!row)return null;
   const raw=invitationToken(key,row),digest=hash(raw);
   if(row.token_hash && row.token_hash!==digest){await store.retireReviewInvitation(row.id,row.claim_token,time);reportFailure();return {reviewRequired:true};}
   hashes.set(row.claim_token,digest);
   const link=origin+'/review.html#token='+raw;
   return {...row,kind:'review_invitation',payload:{to:row.recipient,subject:'How Was Your Ride? | ER Limousine Service',text:'ER Limousine Service\n\nThank you for riding with ER Limousine Service. We would appreciate hearing about your experience.\n\nRate Your Experience: '+link+'\n\nThis private review invitation expires in 30 days. Please share feedback only about your own ride.',html:'<h1>ER Limousine Service</h1><p>Thank you for riding with ER Limousine Service. We would appreciate hearing about your experience.</p><p><a href="'+link+'">Rate Your Experience</a></p><p>This private review invitation expires in 30 days. Please share feedback only about your own ride.</p>'},reviewHash:digest};
  },
  prepareBookingEmail:async(id,claim,message,time)=>{
   const digest=hashes.get(claim);hashes.delete(claim);if(!digest)return null;
   const row=await store.prepareReviewInvitation(id,claim,digest,time,INVITATION_TTL);
   return row?{...row,payload:message}:null;
  },
  finishBookingEmail:(...args)=>store.finishReviewInvitation(...args)
 },provider:enabled?provider:{enabled:false},siteUrl,contact:{},now,reportFailure});
 return {run:queue.run,enabled};
}
module.exports={INVITATION_TTL,uuid,fail,hash,tokenHash,invalidLink,reviewInput,displayName,moderationInput,pageQuery,reviewPage,publicReviewPage,PUBLIC_REVIEW_SCAN_LIMIT,invitationToken,reviewInvitations,reviewPrivacy,requirePublicationPrivacy};
