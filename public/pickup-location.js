// One explicit, short-lived device-location lookup. Never persist coordinates.
function createPickupLocation({input,button,status,beforeStart,onSelect}) {
  const label='📍 Use My Current Location';
  let generation=0,busy=false,controller=null,deadline=null,option=null;
  function message(text){status.textContent=text;status.hidden=!text;}
  function setBusy(value){
    busy=value;button.disabled=value;if(option)option.disabled=value;
    input.setAttribute('aria-busy',String(value));
  }
  function clearOption(){option=null;button.hidden=!!input.value.trim();}
  function cancel(){
    generation++;if(controller)controller.abort();controller=null;clearTimeout(deadline);deadline=null;
    setBusy(false);message('');clearOption();
  }
  function start(){
    if(busy)return;
    cancel();beforeStart();
    const request=++generation,value=input.value,placeId=input.dataset.placeId || '';
    const current=()=>{
      if(request!==generation)return false;
      if(input.value!==value || (input.dataset.placeId || '')!==placeId){cancel();return false;}
      return true;
    };
    const finish=text=>{if(!current())return;clearTimeout(deadline);deadline=null;controller=null;setBusy(false);message(text);clearOption();};
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
          const address=await response.json();if(!current())return;
          if(typeof address.description!=='string'||!address.description.trim()||address.description.length>400||typeof address.placeId!=='string'||address.placeId&&!/^[A-Za-z0-9_-]{1,255}$/.test(address.placeId))throw Error('unavailable');
          // Commit through the existing address/quote integration, without coordinates.
          finish('Pickup address filled. Please check it before getting your quote.');onSelect(address);
        }catch(_){finish('We couldn’t find your pickup address. Please enter it manually.');}
      },error=>{
        finish(error?.code===1?'Location access was denied. Please enter your pickup address manually.':error?.code===3?'Location lookup timed out. Please enter your pickup address manually.':'Your location is unavailable. Please enter your pickup address manually.');
      },{enableHighAccuracy:true,timeout:10000,maximumAge:0});
    }catch(_){finish('Location services are unavailable. Please enter your pickup address manually.');}
  }
  function addOption(container){
    option=document.createElement('button');option.type='button';option.className='address-suggestion current-location-option';option.textContent=label;option.disabled=busy;
    option.addEventListener('mousedown',event=>event.preventDefault());
    option.addEventListener('click',start);container.appendChild(option);button.hidden=true;
  }
  button.addEventListener('click',start);input.addEventListener('input',cancel);window.addEventListener('pagehide',cancel);
  return {cancel,start,addOption,clearOption};
}
