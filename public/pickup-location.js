// One explicit, short-lived device-location lookup. Never persist coordinates.
function createPickupLocation({input,button,status,review,proposed,confirmButton,editButton,beforeStart,onSelect}) {
  const label='📍 Use My Current Location';
  let generation=0,busy=false,controller=null,deadline=null,option=null;
  let pending = null;
  let confirmed = null;
  function message(text){status.textContent=text;status.hidden=!text;}
  function setBusy(value){
    busy=value;button.disabled=value;if(option)option.disabled=value;
    input.setAttribute('aria-busy',String(value));
  }
  function clearOption(){option=null;button.hidden=!!input.value.trim()||!!pending;}
  function cancel(){
    generation++;if(controller)controller.abort();controller=null;clearTimeout(deadline);deadline=null;
    pending = null;
    review.hidden = true;
    proposed.textContent = '';
    setBusy(false);message('');clearOption();
  }
  function matchesPickup(address) {
    return input.value === address.description && (input.dataset.placeId || '') === address.placeId;
  }
  function validate() {
    if (!pending) return true;
    if (!matchesPickup(pending.previousPickup)) {
      cancel();
      return true;
    }
    confirmButton.focus();
    return false;
  }
  function start(){
    if(busy)return;
    cancel();beforeStart();
    const request = ++generation;
    const previousPickup = {description:input.value, placeId:input.dataset.placeId || ''};
    if (confirmed && !matchesPickup(confirmed)) confirmed = null;
    const current=()=>{
      if(request!==generation)return false;
      if(!matchesPickup(previousPickup)){cancel();return false;}
      return true;
    };
    const finish = text => {
      if (!current()) return false;
      generation++;
      clearTimeout(deadline);deadline=null;controller=null;
      setBusy(false);message(text);clearOption();
      return true;
    };
    if(!window.isSecureContext || !navigator.geolocation){finish('Location services are unavailable. Please enter your pickup address manually.');return;}
    setBusy(true);message('Detecting your location…');
    // A separate deadline also bounds browsers that leave a permission prompt open.
    deadline=setTimeout(()=>{if(!current())return;if(controller)controller.abort();generation++;setBusy(false);message('Location lookup timed out. Please enter your pickup address manually.');clearOption();},20000);
    try {
      navigator.geolocation.getCurrentPosition(async position=>{
        if(!current())return;
        try {
          const latitude=position.coords?.latitude,longitude=position.coords?.longitude;
          if(!Number.isFinite(latitude)||!Number.isFinite(longitude)||latitude < -90||latitude > 90||longitude < -180||longitude > 180)throw Error('unavailable');
          controller=new AbortController();
          const response=await fetch('/api/reverse-geocode',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',cache:'no-store',referrerPolicy:'no-referrer',signal:controller.signal,body:JSON.stringify({latitude,longitude})});
          if(!current())return;
          if(!response.ok)throw Error('unavailable');
          const {description, placeId} = await response.json();
          if(!current())return;
          if(typeof description!=='string'||!description.trim()||description.length>400||typeof placeId!=='string'||placeId&&!/^[A-Za-z0-9_-]{1,255}$/.test(placeId))throw Error('unavailable');
          // Keep the accepted address and its Place ID on a repeat lookup.
          if (confirmed && confirmed.description === description) {
            finish('Pickup address already confirmed.');
            return;
          }
          if (!finish('Review the detected pickup address.')) return;
          pending = {address:{description, placeId}, previousPickup};
          proposed.textContent = description;
          review.hidden = false;
          clearOption();
        }catch(_){finish('We couldn’t find your pickup address. Please enter it manually.');}
      },error=>{
        finish(error?.code===1?'Location access was denied. Please enter your pickup address manually.':error?.code===3?'Location lookup timed out. Please enter your pickup address manually.':'Your location is unavailable. Please enter your pickup address manually.');
      },{enableHighAccuracy:true,timeout:10000,maximumAge:0});
    }catch(_){finish('Location services are unavailable. Please enter your pickup address manually.');}
  }
  function addOption(container){
    if (pending) return;
    option=document.createElement('button');option.type='button';option.className='address-suggestion current-location-option';option.textContent=label;option.disabled=busy;
    option.addEventListener('mousedown',event=>event.preventDefault());
    option.addEventListener('click',start);container.appendChild(option);button.hidden=true;
  }
  confirmButton.addEventListener('click', () => {
    if (!pending) return;
    const {address, previousPickup} = pending;
    cancel();
    if (!matchesPickup(previousPickup)) return;
    onSelect(address);
    confirmed = address;
    message('Pickup address confirmed.');
  });
  editButton.addEventListener('click', () => {
    cancel();
    input.focus();
    message('Enter or select the correct pickup address.');
  });
  button.addEventListener('click',start);
  input.addEventListener('input', () => {
    confirmed = null;
    cancel();
  });
  window.addEventListener('pagehide',cancel);
  return {cancel,start,addOption,clearOption,validate};
}
