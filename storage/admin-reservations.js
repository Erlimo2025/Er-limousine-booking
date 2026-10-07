const crypto=require('node:crypto');
const ewr=require('../ewr-pickups');
const {paymentVerificationPending}=require('./customer-trips');
const choices={status:['active','all','cancelled','completed'],payment:['all','paid','unpaid','processing','review','refunded'],timing:['upcoming','all','today','tomorrow','past'],airport:['all','ewr','jfk','lga','other'],vehicle:['all','suv','escalade']};
const defaults={status:'active',payment:'all',timing:'upcoming',airport:'all',vehicle:'all'};
const invalid=()=>{throw Object.assign(new Error('Invalid reservation search.'),{status:400});};
function adminQuery(input,now){
 if(Object.keys(input).some(k=>!['search','limit','cursor',...Object.keys(choices)].includes(k)))invalid();
 const q={};for(const [key,values]of Object.entries(choices)){q[key]=input[key]===undefined?defaults[key]:input[key];if(!values.includes(q[key]))invalid();}
 if(input.search!==undefined&&(typeof input.search!=='string'||input.search.length>120||/[\x00-\x1f\x7f]/.test(input.search)))invalid();
 q.search=(input.search || '').trim().replace(/\s+/g,' ');q.terms=q.search.toLowerCase().split(' ').filter(Boolean);if(q.terms.length>6)invalid();
 if(/^[+0-9(). -]+$/.test(q.search)&&q.search.replace(/\D/g,'').length>=7){let digits=q.search.replace(/\D/g,'');if(digits.length===11&&digits[0]==='1')digits=digits.slice(1);q.terms=[digits];}
 const limit=input.limit===undefined?'25':input.limit;if(typeof limit!=='string'||!/^(?:[1-9]|[1-4][0-9]|50)$/.test(limit))invalid();q.limit=Number(limit);
 const hash=crypto.createHash('sha256').update(JSON.stringify({...q,terms:undefined})).digest('hex');q.cursor=null;
 if(input.cursor!==undefined){
  if(typeof input.cursor!=='string'||input.cursor.length>512||!/^[A-Za-z0-9_-]+$/.test(input.cursor))invalid();
  try{const c=JSON.parse(Buffer.from(input.cursor,'base64url').toString());if(!c||Object.keys(c).sort().join(',')!=='at,hash,id,start'||c.hash!==hash||typeof c.id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(c.id)||!iso(c.start)||!iso(c.at)||Date.parse(c.at)>now||Date.parse(c.at)<now-86400000)invalid();q.cursor=c;}catch(_){invalid();}
 }
 q.at=q.cursor?.at || new Date(now).toISOString();q.hash=hash;
 const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(q.at));
 const part=k=>parts.find(x=>x.type===k).value;q.today=part('year')+'-'+part('month')+'-'+part('day');q.tomorrow=new Date(Date.parse(q.today+'T00:00:00Z')+86400000).toISOString().slice(0,10);return q;
}
const iso=x=>typeof x==='string'&&Number.isFinite(Date.parse(x))&&new Date(x).toISOString()===x;
// Operational labels only; these never establish airport identity for pricing.
const airportPatterns={ewr:'\\mNewark( Liberty)?( International)? Airport\\M',jfk:'\\m(John F[.]? Kennedy( International)?|JFK( International)?) Airport\\M',lga:'\\m(LaGuardia|LGA) Airport\\M'};
const pickupStart="((record->'trip'->>'date')||' '||(record->'trip'->>'time'))::timestamp AT TIME ZONE 'America/New_York'";
const legacyEnd=`CASE WHEN record->'trip'->>'tripType'='roundtrip' THEN ((record->'trip'->>'returnDate')||' '||(record->'trip'->>'returnTime'))::timestamp AT TIME ZONE 'America/New_York' ELSE (${pickupStart}) + CASE WHEN record->'trip'->>'tripType'='hourly' THEN (record->'trip'->>'hours')::numeric * interval '1 hour' ELSE interval '0' END END`;
function searchSql(q){
 const values=[],bind=x=>{values.push(x);return '$'+values.length;},where=[];
 const status="record->>'status'",payment="record->>'paymentStatus'";
 if(q.status==='active')where.push(`${status} NOT IN ('cancelled','completed')`);else if(q.status!=='all')where.push(`${status}=${bind(q.status)}`);
 const pending=`(${payment}<>'paid' AND record->'checkoutAttempt'->>'state'='session_identified' AND record->'checkoutAttempt'->>'evidence' IN ('verified_paid_awaiting_webhook','payment_pending'))`;
 const review="(COALESCE((record->>'paymentReviewRequired')::boolean,false) OR record->'checkoutAttempt'->>'state'='review_required' OR record->>'refundStatus' IN ('review_required','failed'))";
 if(q.payment==='paid')where.push(`${payment}='paid'`);
 if(q.payment==='unpaid')where.push(`${payment}<>'paid' AND NOT COALESCE(${pending},false) AND NOT COALESCE(${review},false) AND COALESCE(record->'checkoutAttempt'->>'state','')<>'submitted_unknown'`);
 if(q.payment==='processing')where.push(`(${pending} OR record->'checkoutAttempt'->>'state'='submitted_unknown' OR record->>'refundStatus'='processing')`);
 if(q.payment==='review')where.push(review);if(q.payment==='refunded')where.push("record->>'refundStatus'='confirmed'");
 if(q.timing==='upcoming')where.push('finish>'+bind(q.at)+'::timestamptz');if(q.timing==='past')where.push('finish<='+bind(q.at)+'::timestamptz');
 if(['today','tomorrow'].includes(q.timing))where.push("(start AT TIME ZONE 'America/New_York')::date="+bind(q[q.timing])+'::date');
 const airportSql=key=>{const pattern=bind(airportPatterns[key]);let expression=`(record->'trip'->>'pickup' ~* ${pattern} OR record->'trip'->>'dropoff' ~* ${pattern})`;if(key==='ewr'){const ids=bind(Object.keys(ewr));expression=`(${expression} OR record->'trip'->>'pickupPlaceId'=ANY(${ids}::text[]) OR record->'trip'->>'dropoffPlaceId'=ANY(${ids}::text[]))`;}return 'COALESCE('+expression+',false)';};
 if(q.airport==='other')where.push('NOT ('+Object.keys(airportPatterns).map(airportSql).join(' OR ')+')');else if(q.airport!=='all')where.push(airportSql(q.airport));
 if(q.vehicle!=='all')where.push("record->'trip'->>'vehicle'="+bind(q.vehicle));
 const text="lower(concat_ws(' ',id::text,record->'customer'->>'firstName',record->'customer'->>'lastName',record->'customer'->>'email',record->'customer'->>'phone',record->'trip'->>'pickup',record->'trip'->>'dropoff',record->'trip'->>'flightNumber'))";
 for(const term of q.terms){const escaped=term.replace(/[\\%_]/g,'\\$&'),match=text+' LIKE '+bind('%'+escaped+'%')+" ESCAPE E'\\\\'";where.push(/^\+?[0-9().-]+$/.test(term)&&term.replace(/\D/g,'').length>=3?'('+match+" OR regexp_replace(record->'customer'->>'phone','[^0-9]','','g') LIKE "+bind('%'+term.replace(/\D/g,'')+'%')+')':match);}
 if(q.cursor)where.push('(start,id)>('+bind(q.cursor.start)+'::timestamptz,'+bind(q.cursor.id)+'::uuid)');
 const limit=bind(q.limit+1);
 return {text:`WITH scheduled AS (SELECT id,record,COALESCE(scheduled_start_at,${pickupStart}) AS start,COALESCE(scheduled_end_at,${legacyEnd}) AS finish FROM er_reservations) SELECT id,record,start FROM scheduled ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY start ASC,id ASC LIMIT ${limit}`,values};
}
function dispatchAirport(trip,side){
 const id=trip[side+'PlaceId'];
 if(typeof id==='string' && Object.hasOwn(ewr,id))return {code:'EWR',terminal:ewr[id].kind==='terminal'?ewr[id].label:null};
 // Legacy/JFK/LGA display fallback only; never booking or pricing authority.
 const text=typeof trip[side]==='string'?trip[side]:'';
 const airports=[['EWR',/\bNewark(?: Liberty)?(?: International)? Airport\b/i],['JFK',/\b(?:John F\.? Kennedy(?: International)?|JFK(?: International)?) Airport\b/i],['LGA',/\b(?:LaGuardia|LGA) Airport\b/i]];
 const match=airports.find(([,pattern])=>pattern.test(text));if(!match)return null;
 const terminal=/\bTerminal\s+([ABC]|[1-9][0-9]?)(?=\s*(?:[,.)]|$)|\s+(?:at|Newark|John|JFK|LaGuardia|LGA)\b)/i.exec(text);
 return {code:match[0],terminal:terminal?'Terminal '+terminal[1].toUpperCase():null};
}
function adminDto(r){
 const trip={...Object.fromEntries(['pickup','dropoff','date','time','returnDate','returnTime','hours','tripType','vehicle','passengers','flightNumber'].filter(k=>r.trip[k]!==undefined).map(k=>[k,r.trip[k]])),timeZone:'America/New_York',pickupAirport:dispatchAirport(r.trip,'pickup'),dropoffAirport:dispatchAirport(r.trip,'dropoff')};
 for(const [field,max]of [['notes',2000],['airline',120]])if(typeof r.trip[field]==='string' && r.trip[field].trim())trip[field]=r.trip[field].slice(0,max);
 return {id:r.id,customer:{firstName:r.customer.firstName,lastName:r.customer.lastName,email:r.customer.email,phone:r.customer.phone},trip,quote:{total:r.quote.total,currency:r.quote.currency,vehicle:r.trip.vehicle==='suv'?'Luxury SUV':r.quote.vehicle},status:r.status,paymentStatus:r.paymentStatus,paymentReviewRequired:r.paymentReviewRequired===true,paymentVerificationPending:paymentVerificationPending(r),...(r.refundStatus?{refundStatus:r.refundStatus}:{}),dispatch:{...r.dispatch},...(r.checkoutAttempt?{checkoutAttempt:{state:r.checkoutAttempt.state,quote:{promotion:{code:r.checkoutAttempt.quote?.promotion?.code}}}}:{})};
}
function page(rows,q){const subset=rows.slice(0,q.limit),last=subset.at(-1);return {bookings:subset.map(x=>adminDto(x.record)),nextCursor:rows.length>q.limit?Buffer.from(JSON.stringify({hash:q.hash,at:q.at,start:new Date(last.start).toISOString(),id:last.id})).toString('base64url'):null};}
function adminReservationStorage(pool,transaction,validate){return {searchAdminReservations:q=>transaction(async client=>{
 // Read-only, bounded provider-free search; existing storage wrapper sanitizes failures.
 await client.query("SET LOCAL statement_timeout='5s'");const query=searchSql(q),rows=(await client.query(query.text,query.values)).rows;for(const row of rows)validate(row.record);return page(rows,q);
})};}
module.exports={choices,defaults,adminQuery,searchSql,adminReservationStorage,adminDto,page};
