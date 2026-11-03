(function(){
  'use strict';
  const bindings=new WeakMap();
  function mount(container){
    for(const input of container.querySelectorAll('input[type="date"],input[type="time"]')){
      if(bindings.has(input))continue;
      const date=input.getAttribute('type')==='date',format=date?TripDateFormat.date:TripDateFormat.time,parse=date?TripDateFormat.fromDateInput:TripDateFormat.fromTimeInput;
      const wrapper=document.createElement('div'),display=document.createElement('input'),picker=document.createElement('span');
      input.closest('.two-fields')?.classList.add('us-date-pair');
      wrapper.className='us-date-control';display.type='text';display.id=input.id+'-display';display.className='us-date-display';
      display.placeholder=date?'MM/DD/YYYY':'h:mm AM/PM';display.inputMode=date?'numeric':'text';display.autocomplete='off';
      display.pattern=date?'(?:[0-9]{1,2}/[0-9]{1,2}/[0-9]{4}|[0-9]{8})':'(?:0?[1-9]|1[0-2]):[0-5][0-9]\\s*[AaPp][Mm]';
      const label=container.querySelector('label[for="'+input.id+'"]'),name=label?.textContent.trim()||(date?'Date':'Time');
      if(label)label.htmlFor=display.id;else display.setAttribute('aria-label',name);
      // The native control sits over the decorative icon and receives the real
      // tap/focus. iOS can silently ignore showPicker(); never proxy this gesture.
      picker.className='us-date-picker';picker.textContent=date?'▦':'◷';picker.setAttribute('aria-hidden','true');
      input.setAttribute('aria-label','Choose '+name.toLowerCase()+(date?' from calendar':' (New York time)'));
      input.lang='en-US';input.tabIndex=0;input.classList.add('us-date-native');
      input.before(wrapper);wrapper.append(display,input,picker);
      let last=input.value,lastRequired=input.required,writing=false;
      function dispatch(type){writing=true;try{input.dispatchEvent(new Event(type,{bubbles:true}));}finally{writing=false;}}
      function refresh(force=false){
        display.disabled=input.disabled;display.required=input.required;
        if(force||input.value!==last||input.required!==lastRequired){display.value=input.value?format(input.value):'';display.setCustomValidity('');}
        else if(input.value&&document.activeElement!==display&&!display.validity.customError)display.value=format(input.value);
        last=input.value;lastRequired=input.required;
      }
      function invalidMessage(){
        if(input.validity.rangeUnderflow)return 'Choose '+(date?'a date on or after '+format(input.min):'a time at or after '+format(input.min))+'.';
        if(input.validity.rangeOverflow)return 'Choose '+(date?'a date on or before '+format(input.max):'a time at or before '+format(input.max))+'.';
        return date?'Enter a valid date in MM/DD/YYYY format.':'Enter a valid time with AM or PM.';
      }
      display.addEventListener('input',event=>{
        event.stopPropagation();const parsed=parse(display.value);input.value=parsed||'';last=input.value;
        display.setCustomValidity(display.value&&!parsed?invalidMessage():'');dispatch('input');
      });
      display.addEventListener('change',event=>{event.stopPropagation();const parsed=parse(display.value);input.value=parsed||'';if(parsed)display.value=format(parsed);last=input.value;dispatch('change');});
      input.addEventListener('input',()=>{if(!writing)refresh(true);});input.addEventListener('change',()=>{if(!writing)refresh(true);});
      input.addEventListener('invalid',event=>{event.preventDefault();display.setCustomValidity(invalidMessage());display.reportValidity();display.focus();});
      new MutationObserver(()=>refresh()).observe(input,{attributes:true,attributeFilter:['disabled','required','min','max']});
      input.form?.addEventListener('reset',()=>queueMicrotask(()=>refresh(true)));
      bindings.set(input,{refresh,display});refresh(true);
    }
  }
  function refresh(container){for(const input of container.querySelectorAll('input.us-date-native'))bindings.get(input)?.refresh();}
  function focus(input){(bindings.get(input)?.display||input).focus();}
  window.BookingDateControls=Object.freeze({mount,refresh,focus});
})();
