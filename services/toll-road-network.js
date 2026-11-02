'use strict';

// Server-only public infrastructure data. No customer address whitelist, route
// history, provider aggregate arithmetic, or default-free coverage fallback.
const fs=require('node:fs');
const geo=require('./toll-route-evidence'),tariff=require('./official-toll-rates');
const fail=tariff.review,ref=tariff.reference,VERSION=geo.VERSION;
const PA=['lincoln','holland','gwb'],CREDITS=['lincoln','holland','queens_midtown','hugh_carey'];
const AGENCIES={njta:['nj_turnpike','garden_state_parkway'],mta:['queens_midtown','hugh_carey','verrazzano','rfk','bronx_whitestone','throgs_neck','henry_hudson','cross_bay','marine_parkway']};
const id=value=>typeof value==='string'&&/^[a-z][a-z0-9_]{2,49}$/.test(value);
const label=value=>typeof value==='string'&&value.trim()&&value.length<=80&&!/[\x00-\x1f<>]/.test(value);
const validSpan=item=>tariff.instant(item.validFrom)>=tariff.START&&tariff.instant(item.validUntil)<=tariff.END&&tariff.instant(item.validFrom)<tariff.instant(item.validUntil);
const covers=(item,first,last)=>tariff.instant(item.validFrom)<=first&&tariff.instant(item.validUntil)>last;
const gridSize=.005;
let cached=null;

function source(env){
  if(!env||typeof env!=='object')fail('coverage_missing');
  const inline=env.OFFICIAL_TOLL_COVERAGE_JSON,file=env.OFFICIAL_TOLL_NETWORK_FILE;
  if(inline&&file)fail('coverage_source_ambiguous');
  if(file){
    if(typeof file!=='string'||file.length>1024)fail('coverage_missing');
    let handle;try{handle=fs.openSync(file,'r');const stat=fs.fstatSync(handle);
      if(!stat.isFile()||stat.size>8*1024*1024)fail('coverage_too_large');
      const buffer=Buffer.alloc(8*1024*1024+1);let length=0,read;
      do{read=fs.readSync(handle,buffer,length,buffer.length-length,null);length+=read;}while(read&&length<buffer.length);
      if(length>=buffer.length)fail('coverage_too_large');return buffer.toString('utf8',0,length);
    }catch(_){fail('coverage_file_unavailable');}finally{if(handle!==undefined)fs.closeSync(handle);}
  }
  if(typeof inline!=='string'||Buffer.byteLength(inline,'utf8')>8*1024*1024)fail('coverage_missing');return inline;
}
function cells(bounds){
  const result=[],[west,south,east,north]=bounds.map(n=>Math.floor(n/gridSize));
  if((east-west+1)*(north-south+1)>400)fail('coverage_geometry_too_large');
  for(let x=west;x<=east;x++)for(let y=south;y<=north;y++)result.push(x+','+y);
  return result;
}
const bounds=points=>[Math.min(...points.map(p=>p[0])),Math.min(...points.map(p=>p[1])),Math.max(...points.map(p=>p[0])),Math.max(...points.map(p=>p[1]))];
function coverage(env){
  const raw=source(env),hash=geo.digest(raw);if(cached?.hash===hash)return cached.catalog;
  let c;try{c=JSON.parse(raw.replace(/^\uFEFF/,''));}catch(_){fail('coverage_invalid');}
  geo.validateGeography(c);
  if(Object.hasOwn(c,'routes')||!validSpan(c)||!Number.isFinite(c.junctionMeters)||c.junctionMeters<1||c.junctionMeters>8||
    !Array.isArray(c.nodes)||!c.nodes.length||c.nodes.length>20000||!Array.isArray(c.roads)||!c.roads.length||c.roads.length>12000||
    !Array.isArray(c.facilities)||c.facilities.length<3||c.facilities.length>20||!Array.isArray(c.crz.creditConnectors)||c.crz.creditConnectors.length>200)fail('coverage_invalid');
  const nodes=new Map(),roads=new Map(),facilities=new Map(),index=new Map();
  for(const node of c.nodes){
    if(!id(node?.id)||nodes.has(node.id)||!geo.point(node.point)||!['NJ','NY','CT','PA'].includes(node.state))fail('coverage_node_invalid');
    nodes.set(node.id,node);
  }
  for(const f of c.facilities){
    const rateIndex=new Map();
    if(!id(f?.id)||facilities.has(f.id)||!ref(f.evidence)||!label(f.label)||!['pa_2026','table','unsupported'].includes(f.kind))fail('facility_invalid');
    if(f.kind==='pa_2026'){
      if(!PA.includes(f.id)||f.rates!==undefined||f.amountCents!==undefined)fail('facility_invalid');
    }else if(f.kind==='table'){
      if(!AGENCIES[f.authority]?.includes(f.id)||!['entry','exit'].includes(f.timeBasis)||!Array.isArray(f.rates)||!f.rates.length||f.rates.length>10000)fail('facility_rates_unverified');
      for(const rate of f.rates)if(!rate||typeof rate!=='object'||Array.isArray(rate)||!nodes.has(rate.entry)||!nodes.has(rate.exit)||rate.entry===rate.exit||!validSpan(rate)||!ref(rate.evidence)||!ref(rate.version)||
        typeof rate.vehicleClass!=='string'||!/^[A-Za-z0-9_-]{1,20}$/.test(rate.vehicleClass)||rate.tollPass!=='US_NJ_EZPASSNJ'||rate.currency!=='USD'||
        !Number.isSafeInteger(rate.amountCents)||rate.amountCents<0||rate.amountCents>100000||
        !Array.isArray(rate.days)||!rate.days.length||rate.days.length>7||new Set(rate.days).size!==rate.days.length||!rate.days.every(n=>Number.isInteger(n)&&n>=0&&n<=6)||
        !Number.isInteger(rate.startMinute)||!Number.isInteger(rate.endMinute)||rate.startMinute<0||rate.startMinute>=rate.endMinute||rate.endMinute>1440)fail('facility_rates_unverified');
      for(const rate of f.rates){const key=[rate.entry,rate.exit,rate.vehicleClass,rate.tollPass].join('|'),records=rateIndex.get(key)||[];
        if(records.length>=512)fail('facility_rates_excessive');records.push(rate);rateIndex.set(key,records);}
    }
    facilities.set(f.id,{...f,rateIndex});
  }
  if(!PA.every(name=>facilities.get(name)?.kind==='pa_2026'))fail('facility_missing');
  for(const road of c.roads){
    const from=nodes.get(road?.from),to=nodes.get(road?.to);
    if(!id(road?.id)||roads.has(road.id)||!from||!to||from===to||!['free','facility','unsupported'].includes(road.kind)||
      typeof road.bothDirections!=='boolean'||!ref(road.evidence)||!validSpan(road)||!geo.polygon(road.corridor)||road.corridor.length>12||!geo.convex(road.corridor)||
      road.kind==='facility'&&!facilities.has(road.facility)||road.kind!=='facility'&&road.facility!==undefined)fail('road_coverage_invalid');
    const length=geo.distance(from.point,to.point),scale=Math.cos(from.point[1]*Math.PI/180),x=(to.point[0]-from.point[0])*scale,y=to.point[1]-from.point[1];
    const along=p=>(((p[0]-from.point[0])*scale*x+(p[1]-from.point[1])*y)/(x*x+y*y));
    if(length<10||length>2500||!geo.inside(from.point,road.corridor)||!geo.inside(to.point,road.corridor)||road.corridor.some(p=>
      geo.nearSegment(p,from.point,to.point).distance>22||along(p)<-c.junctionMeters/length||along(p)>1+c.junctionMeters/length))fail('road_corridor_invalid');
    const edge={...road,start:from,end:to,length,along,token:road.id+':f'};
    roads.set(road.id,edge);
    for(const key of cells(bounds(road.corridor))){const list=index.get(key)||[];if(list.length>=2000)fail('coverage_density_excessive');list.push(edge);index.set(key,list);}
  }
  for(const connector of c.crz.creditConnectors)if(!CREDITS.includes(connector?.source)||!ref(connector.evidence)||!validSpan(connector)||
    connector.movement!==undefined&&!['entry','exit'].includes(connector.movement)||
    !Array.isArray(connector.roads)||!connector.roads.length||connector.roads.length>30||connector.roads.some(token=>typeof token!=='string'||
      !/^[a-z][a-z0-9_]{2,49}:[fr]$/.test(token)||!roads.has(token.slice(0,-2))))fail('credit_connector_invalid');
  const catalog={...c,catalogHash:geo.digest(c),nodesById:nodes,roadsById:roads,facilitiesById:facilities,index};
  cached={hash,catalog};return catalog;
}

// Exact clipping against convex road cells covers every point of every route
// segment, including segments whose provider vertices span several road links.
function clip(a,b,polygon){
  let area=0;for(let i=0;i<polygon.length;i++){const p=polygon[i],q=polygon[(i+1)%polygon.length];area+=p[0]*q[1]-q[0]*p[1];}
  const sign=Math.sign(area);let lo=0,hi=1;
  for(let i=0;i<polygon.length;i++){
    const p=polygon[i],q=polygon[(i+1)%polygon.length],x=q[0]-p[0],y=q[1]-p[1];
    const start=sign*(x*(a[1]-p[1])-y*(a[0]-p[0])),slope=sign*(x*(b[1]-a[1])-y*(b[0]-a[0]));
    if(Math.abs(slope)<1e-18){if(start< -1e-14)return null;continue;}
    const t=(-1e-14-start)/slope;if(slope>0)lo=Math.max(lo,t);else hi=Math.min(hi,t);
    if(lo>hi)return null;
  }
  return hi-lo>1e-10?[Math.max(0,lo),Math.min(1,hi)]:null;
}
const interpolate=(a,b,t)=>[a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t];
function matchRoute(g,c,first,last){
  let states=[],comparisons=0,initialized=false;
  for(let segment=0;segment<g.points.length-1;segment++){
    const a=g.points[segment],b=g.points[segment+1];if(geo.distance(a,b)<.001)continue;
    const possible=new Map();for(const key of cells(bounds([a,b])))for(const road of c.index.get(key)||[])possible.set(road.id,road);
    const matches=[],cuts=[0,1];
    for(const road of possible.values()){
      if(++comparisons>2000000)fail('coverage_match_too_complex');
      const interval=clip(a,b,road.corridor);if(!interval)continue;
      const delta=road.along(b)-road.along(a),forward=delta>0;
      const progress=Math.abs(delta)*road.length/geo.distance(a,b);
      if(progress<.7||!forward&&!road.bothDirections)continue;
      const edge=forward?road:{...road,start:road.end,end:road.start,token:road.id+':r',along:p=>1-road.along(p)};
      matches.push({edge,interval});cuts.push(...interval);
    }
    cuts.sort((x,y)=>x-y);
    for(let i=1;i<cuts.length;i++){
      const lo=cuts[i-1],hi=cuts[i];if(hi-lo<1e-9)continue;
      comparisons+=matches.length;if(comparisons>2000000)fail('coverage_match_too_complex');
      const start=interpolate(a,b,lo),end=interpolate(a,b,hi),choices=matches.filter(m=>m.interval[0]<=lo+1e-10&&m.interval[1]>=hi-1e-10),next=[];
      for(const {edge}of choices){
        const item={edge,startSegment:segment,endSegment:segment,startFraction:lo,endFraction:hi,fromAlong:edge.along(start),toAlong:edge.along(end)};
        if(!initialized)next.push({path:[item],signature:edge.token});
        for(const state of states){
          if(next.length>=256)fail('coverage_match_too_complex');
          const prev=state.path.at(-1);
          if(prev.edge.token===edge.token){
            if(item.fromAlong+1e-6<prev.toAlong)continue;
            next.push({path:[...state.path.slice(0,-1),{...prev,endSegment:segment,endFraction:hi,toAlong:item.toAlong}],signature:state.signature});
          }else if(prev.edge.end.id===edge.start.id&&geo.distance(start,edge.start.point)<=c.junctionMeters+.02){
            if(state.path.length>=1200)fail('coverage_match_too_complex');
            next.push({path:[...state.path,item],signature:state.signature+'|'+edge.token});
          }
        }
      }
      const unique=new Map();for(const state of next)unique.set(state.signature,state);
      states=[...unique.values()];if(!states.length)fail('unmatched_road_segment');if(states.length>64)fail('ambiguous_road_network');initialized=true;
    }
  }
  if(states.length!==1)fail('ambiguous_road_network');
  const path=states[0].path;
  for(const {edge}of path){
    if(!covers(edge,first,last))fail('road_coverage_expired');
    if(edge.kind==='unsupported'||edge.kind==='facility'&&c.facilitiesById.get(edge.facility).kind==='unsupported')fail('unsupported_road');
  }
  return path;
}
function facilityRuns(path,c){
  const result=[];
  for(let i=0;i<path.length;i++){
    const item=path[i];if(item.edge.kind!=='facility')continue;
    const start=i,id=item.edge.facility;while(i+1<path.length&&path[i+1].edge.facility===id)i++;
    if(start===0||i===path.length-1)fail('facility_entry_exit_incomplete');
    if(result.some(run=>run.id===id))fail('repeated_facility_requires_review');
    result.push({id,facility:c.facilitiesById.get(id),start,end:i,entry:path[start].edge.start.id,exit:path[i].edge.end.id,
      startSegment:path[start].startSegment,endSegment:path[i].endSegment});
  }
  return result;
}
function tableRate(run,g,profile,departure){
  const f=run.facility,authority=profile.official.fleet.authorities?.[f.authority];
  const window=geo.windowAt(g,f.timeBasis==='entry'?run.startSegment:run.endSegment,departure,profile);
  if(!authority||!ref(authority.evidence)||typeof authority.vehicleClass!=='string'||tariff.instant(authority.validUntil)<=tariff.instant(window.latest))fail('authority_class_unverified');
  const first=tariff.instant(window.earliest),last=tariff.instant(window.latest),times=[first,last];
  for(let t=Math.floor(first/60000)*60000+60000;t<last;t+=60000)times.push(t);
  let selected=null;
  const candidates=f.rateIndex.get([run.entry,run.exit,authority.vehicleClass,'US_NJ_EZPASSNJ'].join('|'))||[];
  for(const time of times){
    const p=tariff.parts(time),weekday=new Date(p.day+'T12:00:00Z').getUTCDay();
    const rates=candidates.filter(rate=>profile.tollPasses.includes(rate.tollPass)&&covers(rate,time,time)&&rate.days.includes(weekday)&&p.minute>=rate.startMinute&&p.minute<rate.endMinute);
    if(rates.length!==1||selected&&geo.digest(selected)!==geo.digest(rates[0]))fail('facility_tariff_missing_or_uncertain');selected=rates[0];
  }
  return selected;
}
function creditSource(event,path,runs,c,departure,g,profile){
  const at=path.findIndex(item=>(event.segment>item.startSegment||event.segment===item.startSegment&&event.fraction>=item.startFraction-1e-9)&&
    (event.segment<item.endSegment||event.segment===item.endSegment&&event.fraction<=item.endFraction+1e-9));
  if(at<0)fail('zone_road_match_missing');
  if(event.kind==='exit'){
    const run=runs.find(run=>['queens_midtown','hugh_carey'].includes(run.id)&&run.end>=at);
    if(!run)return null;
    if(at>=run.start)return run;
    const tokens=path.slice(at,run.start).map(item=>item.edge.token),window=geo.windowAt(g,event.segment,departure,profile);
    const connectors=c.crz.creditConnectors.filter(item=>item.movement==='exit'&&item.source===run.id&&JSON.stringify(item.roads)===JSON.stringify(tokens)&&
      covers(item,tariff.instant(window.earliest),tariff.instant(window.latest)));
    if(connectors.length!==1)fail('credit_connector_unverified');return run;
  }
  const candidates=runs.filter(run=>CREDITS.includes(run.id)&&run.start<=at&&(run.facility.kind!=='pa_2026'||run.direction==='ny_bound'));
  if(!candidates.length)return null;
  const run=candidates.at(-1);if(at<=run.end)return run;
  const tokens=path.slice(run.end+1,at+1).map(item=>item.edge.token),window=geo.windowAt(g,event.segment,departure,profile);
  const connectors=c.crz.creditConnectors.filter(item=>(item.movement||'entry')==='entry'&&item.source===run.id&&JSON.stringify(item.roads)===JSON.stringify(tokens)&&
    covers(item,tariff.instant(window.earliest),tariff.instant(window.latest)));
  if(connectors.length!==1)fail('credit_connector_unverified');return run;
}
function dailyContext(profile,day,seen,departure,latest=departure,now=Date.now()){
  if(!(seen instanceof Map))fail('daily_context_unverified');
  const vehicle=profile.official.fleet.vehicleRef,key=vehicle+'|'+day;
  if(seen.has(key)){
    const previous=seen.get(key);if(!previous||tariff.instant(previous.validUntil)<=tariff.instant(latest))fail('daily_context_unverified');
    return {...previous,...tariff.dailyLedger(previous)};
  }
  const fact=profile.official.dailyFacts?.[day];
  if(fact){
    const observed=tariff.instant(fact.observedAt),until=tariff.instant(fact.validUntil);
    const amounts=tariff.dailyLedger(fact);
    if(fact.vehicleRef!==vehicle||!['first_entry','already_charged'].includes(fact.status)||fact.historyComplete!==true||
      (fact.status==='first_entry')!==(amounts.chargedCents===0)||!ref(fact.evidence)||tariff.parts(observed).day!==day||
      !Number.isFinite(now)||observed>now||observed>tariff.instant(departure)||until<=tariff.instant(latest)||tariff.parts(until-1).day!==day)fail('daily_context_unverified');
    return {day,status:fact.status,...amounts,historyComplete:true,evidence:fact.evidence,validUntil:fact.validUntil};
  }
  // A previously approved estimate policy is not complete daily history.
  fail('daily_context_unknown');
}
function priceRoutes(routes,profile,env,eligibility,context={}){
  if(!profile?.official||!Array.isArray(routes)||routes.length<1||routes.length>2||eligibility?.policy!=='interstate_only'||
    eligibility.pickupState===eligibility.dropoffState||!ref(profile.official.fleet?.vehicleRef)||!ref(profile.official.fleet?.assignmentEvidence))fail('fleet_or_route_unverified');
  const c=coverage(env),seen=new Map(),legs=[],proofs=[];let previousEnd=null;
  for(const [index,route]of routes.entries()){
    if(route.origin!==(index?eligibility.dropoffPlaceId:eligibility.pickupPlaceId)||route.destination!==(index?eligibility.pickupPlaceId:eligibility.dropoffPlaceId))fail('route_endpoint_unverified');
    const g=geo.geometry(route.data),first=tariff.instant(route.departure),last=tariff.instant(geo.windowAt(g,g.segments.length-1,route.departure,profile).latest);
    if(previousEnd!==null&&first<previousEnd)fail('route_time_order_unverified');previousEnd=last;
    if(!covers(c,first,last))fail('coverage_expired');tariff.verifiedFleet(profile.official.fleet,last);
    const path=matchRoute(g,c,first,last),start=path[0].edge,end=path.at(-1).edge;
    if(start.start.state!==start.end.state||end.start.state!==end.end.state||start.start.state!==(index?eligibility.dropoffState:eligibility.pickupState)||
      end.end.state!==(index?eligibility.pickupState:eligibility.dropoffState))fail('route_endpoint_state_mismatch');
    const gate=geo.crossingEvents(g.points,c),runs=facilityRuns(path,c),pa=runs.filter(run=>run.facility.kind==='pa_2026');
    if(pa.length!==1||pa[0].id!==gate.crossing||gate.segment<pa[0].startSegment||gate.segment>pa[0].endSegment)fail('crossing_road_mismatch');
    pa[0].direction=gate.direction;
    const base=tariff.calculateTariff({version:tariff.VERSION,routeVerified:true,coverageVerified:true,coverageEvidence:c.evidence,crossing:gate.crossing,direction:gate.direction,
      crossingTime:geo.windowAt(g,gate.segment,route.departure,profile),fleet:profile.official.fleet,entersCrz:false,otherTolls:[]});
    pa[0].amountCents=base.amountCents;
    const other=[],rateProofs=[];
    for(const run of runs)if(run.facility.kind==='table'){
      const rate=tableRate(run,g,profile,route.departure);run.amountCents=rate.amountCents;rateProofs.push(geo.digest(rate));
      other.push({kind:'other',label:run.facility.label,facility:run.id,amountCents:rate.amountCents});
    }
    const entries=geo.zoneTransitions(g.points,c.crz),events=[],usedRuns=new Set(),sourceIds=new Set();let day=null,congestion=0,credit=0;
    if(entries.length>32)fail('congestion_events_excessive');
    for(const entry of entries){
      let source=creditSource(entry,path,runs,c,route.departure,g,profile);
      const token=source?geo.digest({leg:index,facility:source.id,roads:path.slice(source.start,source.end+1).map(item=>item.edge.token)}):null;
      if(token&&usedRuns.has(token))source=null;
      if(entry.kind==='exit'&&!source)continue;
      const window=geo.windowAt(g,entry.segment,route.departure,profile),eventDay=tariff.rateWindow(window,'mta').day;
      if(day!==null&&eventDay!==day)fail('multiple_zone_days_unverified');day=eventDay;
      const crossingTime=source?{earliest:geo.windowAt(g,source.startSegment,route.departure,profile).earliest,
        latest:geo.windowAt(g,source.endSegment,route.departure,profile).latest}:null;
      const latest=crossingTime&&tariff.instant(crossingTime.latest)>tariff.instant(window.latest)?crossingTime.latest:window.latest;
      const daily=dailyContext(profile,day,seen,window.earliest,latest,context.now??Date.now()),account=profile.official.crossingCredit;
      if(source&&(!account||tariff.instant(account.validUntil)<=tariff.instant(latest)))fail('crossing_credit_unverified');
      const crz=tariff.calculateCongestion({movement:entry.kind,zoneEntryTime:window,crossingTime,fleet:profile.official.fleet,dailyContext:daily,
        creditSource:source?.id||null,crossingPaidCents:source?.amountCents||0,creditEligibility:account?.eligibility,creditEvidence:account?.evidence});
      congestion+=crz.amountCents;credit+=crz.creditCents;
      if(source){usedRuns.add(token);sourceIds.add(source.id);}
      events.push({...crz.event,creditToken:source?token:null});
      seen.set(profile.official.fleet.vehicleRef+'|'+day,{...daily,...crz.stateAfter,status:crz.stateAfter.chargedCents?'already_charged':'first_entry'});
    }
    const components=[base.components[0],{kind:'mta_congestion',label:'MTA congestion',facility:'manhattan_crz',amountCents:congestion},
      {kind:'crossing_credit',label:'Eligible credit',facility:'manhattan_crz_credit',amountCents:credit?-credit:0},...other];
    const amountCents=components.reduce((n,component)=>n+component.amountCents,0);
    if(!Number.isSafeInteger(amountCents)||amountCents<0)fail('invalid_total');
    legs.push({status:'estimated',amountCents,components,crossing:gate.crossing,direction:gate.direction,geometryHash:g.hash,
      congestionDay:day,dailyAssumption:null,creditSource:sourceIds.size===1?[...sourceIds][0]:null,congestionEvents:events});
    proofs.push(geo.digest({roads:path.map(item=>item.edge.token),rates:rateProofs}));
  }
  const amountCents=legs.reduce((n,leg)=>n+leg.amountCents,0);
  return {version:1,format:'official_network_2026',networkVersion:VERSION,tariffVersion:tariff.CREDIT_VERSION,status:'estimated',amountCents,estimatedRouteCents:amountCents,
    allowanceCents:0,eligibility,legs,coverageHash:geo.digest({catalog:c.catalogHash,proofs}),fleetHash:geo.digest(profile.official)};
}
module.exports={VERSION,coverage,clip,matchRoute,facilityRuns,tableRate,dailyContext,priceRoutes};
