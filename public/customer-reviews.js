(() => {
 'use strict';
 const form=document.getElementById('customerReviewForm');
 if(form){
  const status=document.getElementById('reviewStatus'),button=document.getElementById('submitReview');
  let token=null,busy=false;
  try{const params=new URLSearchParams(location.hash.slice(1));if([...params.keys()].join(',')==='token' && /^[A-Za-z0-9_-]{43}$/.test(params.get('token')))token=params.get('token');history.replaceState(null,'',location.pathname);}catch(_){}
  const send=async(path,body)=>{const response=await fetch(path,{method:'POST',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const data=await response.json();if(!response.ok)throw Error(data.error || 'Your review could not be submitted. Please try again.');return data;};
  form.addEventListener('change',()=>{const value=Number(new FormData(form).get('rating'));for(const label of form.querySelectorAll('.review-stars label'))label.classList.toggle('selected',Number(label.querySelector('input').value)<=value);});
  form.addEventListener('submit',async event=>{
   event.preventDefault();if(busy || !token || !form.reportValidity())return;
   busy=true;button.disabled=true;status.textContent='Submitting your review…';
   try{await send('/api/reviews',{token,rating:Number(new FormData(form).get('rating')),comment:document.getElementById('reviewComment').value});token=null;form.reset();form.hidden=true;status.textContent='Thank you for your feedback!';}
   catch(error){status.textContent=error.message;}finally{busy=false;button.disabled=false;}
  });
  window.addEventListener('pagehide',()=>{token=null;form.reset();form.hidden=true;});
  if(!token)status.textContent='Please open your private review invitation from your email.';
  else send('/api/reviews/invitation',{token}).then(()=>{form.hidden=false;status.textContent='Thank you for riding with us.';}).catch(error=>{token=null;status.textContent=error.message;});
 }
 const section=document.getElementById('customerReviews');
 if(section){
  const list=document.getElementById('publicReviewsList'),more=document.getElementById('publicReviewsMore'),status=document.getElementById('publicReviewsStatus'),seen=new Set();let cursor=null,busy=false;
  async function load(){
   if(busy)return;busy=true;more.disabled=true;
   try{for(let scan=0;scan<5;scan++){
    const response=await fetch('/api/reviews/public?limit=6'+(cursor?'&cursor='+encodeURIComponent(cursor):''),{credentials:'omit',cache:'no-store'});if(!response.ok)throw Error();const data=await response.json();
    for(const review of data.reviews){if(seen.has(review.id))continue;seen.add(review.id);const card=document.createElement('article');card.className='customer-review-card';const stars=document.createElement('div');stars.className='review-public-stars';stars.setAttribute('aria-label',review.rating+' out of 5 stars');stars.textContent='★'.repeat(review.rating)+'☆'.repeat(5-review.rating);card.append(stars);if(review.comment){const comment=document.createElement('p');comment.textContent=review.comment;card.append(comment);}const name=document.createElement('footer');name.textContent=review.displayName;card.append(name);list.append(card);}
    cursor=data.nextCursor;if(seen.size || !cursor)break;
    }more.hidden=!cursor;section.hidden=seen.size===0;status.textContent='';
   }catch(_){if(seen.size)status.textContent='More reviews are temporarily unavailable.';}finally{busy=false;more.disabled=false;}
  }
  more.addEventListener('click',load);void load();
 }
})();
