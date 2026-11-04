(() => {
 'use strict';
 const panel=document.getElementById('adminReviews');if(!panel)return;
 const view=document.getElementById('adminReviewsView'),list=document.getElementById('adminReviewsList'),status=document.getElementById('adminReviewsStatus'),more=document.getElementById('adminReviewsMore');
 let authenticated=false,fetchAdmin=null,generation=0,cursor=null;const requests=new Map();
 const node=(tag,text,className)=>{const el=document.createElement(tag);if(text!==undefined)el.textContent=text;if(className)el.className=className;return el;};
 const reasons=[['','Choose a reason for keeping private'],['spam','Spam'],['authenticity','Authenticity concern'],['privacy','Private information'],['inappropriate_content','Inappropriate content'],['customer_request','Customer removal request']];
 function render(review){
  const card=node('article',undefined,'booking-item review-item');card.dataset.reviewId=review.id;
  card.append(node('h3',review.customerName),node('p',review.rating+' out of 5 stars · '+review.status,'review-meta'));
  if(review.comment)card.append(node('p',review.comment,'review-comment'));
  if(review.privacyBlocked===true){const warning=node('p','Privacy warning: publication blocked. Possible '+review.privacyReasons.join(', ')+'. Keep the original review and rating private. No approval override is available.','review-meta');warning.setAttribute('role','status');card.append(warning);}
  card.append(node('p','Reservation: '+review.reservationReference+' · Submitted: '+new Intl.DateTimeFormat('en-US',{dateStyle:'short',timeStyle:'short',timeZone:'America/New_York'}).format(new Date(review.submittedAt))+' (New York time)','review-meta'));
  const reason=node('select');reason.setAttribute('aria-label','Reason for keeping review private');for(const [value,label]of reasons){const option=node('option',label);option.value=value;reason.append(option);}card.append(reason);
  const actions=node('div',undefined,'hero-actions'),message=node('p',undefined,'review-meta');message.setAttribute('role','status');
  for(const [action,label]of review.status==='published'?[['remove','Remove From Public']]:[['publish','Approve & Publish'],['hold','Hold / Keep Private']]){
   const button=node('button',label,'btn btn-secondary');button.type='button';button.dataset.reviewAction=action;actions.append(button);
   if(action==='publish' && review.privacyBlocked===true)button.disabled=true;
   button.addEventListener('click',async()=>{
    if(!authenticated || requests.has(review.id))return;
    if(action!=='publish' && !reason.value){message.textContent='Choose a moderation reason.';return;}
    if(['publish','remove'].includes(action) && !window.confirm(action==='publish'?'Publish this original review on the customer website? Apply the same rules to all ratings.':'Remove this review from public display and keep its private audit history?'))return;
    const request=generation,operation={};requests.set(review.id,operation);actions.querySelectorAll('button').forEach(b=>b.disabled=true);
    try{await fetchAdmin('/api/admin/reviews/'+encodeURIComponent(review.id)+'/moderate',{method:'POST',body:JSON.stringify({action,reason:action==='publish'?'authentic_feedback':reason.value,version:review.version,requestId:crypto.randomUUID(),confirmed:true})});if(authenticated && request===generation)await load(false);}
    catch(error){if(authenticated && request===generation && card.isConnected)message.textContent=error.message;}
    finally{if(requests.get(review.id)===operation)requests.delete(review.id);if(card.isConnected)actions.querySelectorAll('button').forEach(b=>b.disabled=b.dataset.reviewAction==='publish' && review.privacyBlocked===true);}
   });
  }
  const historyButton=node('button','Moderation History','btn btn-secondary'),history=node('p',undefined,'review-history');historyButton.type='button';history.hidden=true;actions.append(historyButton);
  historyButton.addEventListener('click',async()=>{const request=generation;if(!authenticated)return;historyButton.disabled=true;try{const data=await fetchAdmin('/api/admin/reviews/'+encodeURIComponent(review.id)+'/history');if(authenticated && request===generation && card.isConnected){history.textContent=data.events.length?data.events.map(e=>e.created_at+' · '+e.action+' · '+e.reason+' · Admin '+e.actor_id).join('\n'):'No moderation actions yet.';history.hidden=false;}}catch(error){if(authenticated && request===generation)message.textContent=error.message;}finally{historyButton.disabled=false;}});
  card.append(actions,message,history);return card;
 }
 async function load(append=false){
  if(!authenticated)return;const request=++generation;if(!append){list.replaceChildren();cursor=null;}more.disabled=true;status.textContent='Loading reviews…';
  try{const data=await fetchAdmin('/api/admin/reviews?status='+encodeURIComponent(view.value)+'&limit=20'+(append&&cursor?'&cursor='+encodeURIComponent(cursor):''));if(!authenticated || request!==generation)return;for(const review of data.reviews)list.append(render(review));cursor=data.nextCursor;more.hidden=!cursor;status.textContent=list.children.length?'':'No reviews in this view.';}
  catch(error){if(authenticated && request===generation)status.textContent=error.message;}finally{if(request===generation)more.disabled=false;}
 }
 view.addEventListener('change',()=>void load());more.addEventListener('click',()=>void load(true));panel.addEventListener('toggle',()=>{if(panel.open && authenticated && !list.children.length)void load();});
 window.erCustomerReviews={setAuthenticated(value,request){authenticated=value;fetchAdmin=request || fetchAdmin;generation++;panel.hidden=!value;list.replaceChildren();requests.clear();cursor=null;more.hidden=true;status.textContent='';if(!value){panel.open=false;view.value='pending';}else if(panel.open)void load();}};
 window.addEventListener('pagehide',()=>window.erCustomerReviews.setAuthenticated(false));
})();
