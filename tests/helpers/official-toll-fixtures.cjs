// Synthetic geometry and evidence ONLY. These are not operator attestations or live route surveys.
const e=require('../../services/toll-route-evidence');
const r=require('../../services/official-toll-rates');
const rectangle=(west,south,east,north)=>[[west,south],[east,south],[east,north],[west,north]];
const portals={lincoln:{nj:[-74.021,40.766],ny:[-74.004,40.758]},holland:{nj:[-74.037,40.728],ny:[-74.009,40.726]},gwb:{nj:[-73.963,40.853],ny:[-73.941,40.851]}};
const span={validFrom:'2026-01-04T05:01:00Z',validUntil:'2027-01-01T05:00:00Z'};
function corridor(a,b,width=8,extension=3){const scale=Math.cos(a[1]*Math.PI/180),x=(b[0]-a[0])*scale,y=b[1]-a[1],length=Math.hypot(x,y),dx=x/length,dy=y/length;
 const p=(along,side)=>[a[0]+(dx*along-dy*side)/(111320*scale),a[1]+(dy*along+dx*side)/111320];
 return [p(-extension,-width),p(length*111320+extension,-width),p(length*111320+extension,width),p(-extension,width)];}
function catalog(){const c={version:e.VERSION,...span,junctionMeters:6,evidence:'synthetic-catalog-approval',crossings:Object.entries(portals).map(([id,p])=>({id,...p,
  corridor:rectangle(Math.min(p.nj[0],p.ny[0])-.0015,Math.min(p.nj[1],p.ny[1])-.0015,Math.max(p.nj[0],p.ny[0])+.0015,Math.max(p.nj[1],p.ny[1])+.0015),
  portalRadiusMeters:35,evidence:'synthetic-'+id+'-survey'})),crz:{polygon:rectangle(-74.006,40.70,-73.96,40.764),excluded:[],evidence:'synthetic-zone-survey',creditConnectors:[]},nodes:[],roads:[],facilities:[]};
 for(const id of Object.keys(portals)){
  const points=e.geometry(googleRoute(id)).points;
  points.forEach((point,i)=>c.nodes.push({id:id+'_n'+i,point,state:i<3?'NJ':'NY'}));
  points.slice(1).forEach((point,i)=>c.roads.push({id:id+'_road'+i,from:id+'_n'+i,to:id+'_n'+(i+1),corridor:corridor(points[i],point),
   kind:i===2?'facility':'free',...(i===2?{facility:id}:{}),bothDirections:true,evidence:'synthetic-road-link-survey',...span}));
  c.facilities.push({id,kind:'pa_2026',label:'Port Authority crossing',evidence:'synthetic-pa-facility-survey'});
 }
 c.crz.creditConnectors.push({source:'holland',roads:['holland_road3:f'],evidence:'synthetic-holland-zone-connection',...span});
 return c;}
function encode(points){let lat=0,lng=0,result='';function write(delta){let n=delta<0?-delta*2-1:delta*2;while(n>=32){result+=String.fromCharCode((n%32|32)+63);n=Math.floor(n/32);}result+=String.fromCharCode(n+63);}
 for(const p of points){const y=Math.round(p[1]*1e5),x=Math.round(p[0]*1e5);write(y-lat);write(x-lng);lat=y;lng=x;}return result;}
function googleRoute(crossing='lincoln',direction='ny_bound',amount=1375){
 const p=portals[crossing],points=[[p.nj[0]-.009,p.nj[1]+.004],[p.nj[0]-.0005,p.nj[1]+.0002],p.nj,p.ny,
  crossing==='gwb'?[p.ny[0]+.002,p.ny[1]]:[p.ny[0]+.01,p.ny[1]-.001]];
 if(direction==='nj_bound')points.reverse();
 return {distanceMeters:16093.44,duration:'1200s',staticDuration:'1200s',legs:[{steps:points.slice(1).map((p,i)=>({staticDuration:'300s',polyline:{encodedPolyline:encode([points[i],p])}}))}],
  ...(amount===undefined?{}:{travelAdvisory:{tollInfo:amount===null?{}:{estimatedPrice:[{currencyCode:'USD',units:String(Math.floor(amount/100)),nanos:amount%100*10000000}]}}})};
}
function profile(vehicle='suv'){return {emissionType:'GASOLINE',tollPasses:['US_NJ_EZPASSNJ'],vehicleClass:'2Ax',commercialRatesVerified:false,congestionCoverageVerified:false,
 official2026:{vehicleKey:vehicle,fleet:{paClass:'1',axles:2,singleRearWheels:true,noTrailer:true,accountIssuer:'NJ',tagStatus:'mounted_readable',mtaPlan:'standard_daily',tlcLicensed:false,
 vehicleRef:'synthetic-suburban-01',assignmentEvidence:'synthetic-dispatch-assignment',authorities:{njta:{vehicleClass:'1',evidence:'synthetic-njta-class-proof',validUntil:span.validUntil},mta:{vehicleClass:'1',evidence:'synthetic-mta-class-proof',validUntil:span.validUntil}},
 classEvidence:'synthetic-vehicle-class-record',tagEvidence:'synthetic-readable-tag-record',planEvidence:'synthetic-standard-daily-record',validUntil:'2027-01-01T05:00:00Z'},
 crossingCredit:{eligibility:'eligible',evidence:'synthetic-credit-entitlement',validUntil:span.validUntil},
 timing:{uncertaintySeconds:0,evidence:'synthetic-timing-calibration'},dailyFacts:Object.fromEntries(['2026-11-07','2026-11-08','2026-11-10','2026-11-11'].map(day=>{
  const next=new Date(Date.parse(day+'T05:00:00Z')+86400000).toISOString();
  return [day,{status:'first_entry',vehicleRef:'synthetic-suburban-01',chargedCents:0,creditedCents:0,historyComplete:true,
   observedAt:day+'T05:00:00Z',validUntil:next,evidence:'synthetic-complete-vehicle-day-history'}];}))}};}
function facts(extra={}){return {version:r.VERSION,routeVerified:true,coverageVerified:true,coverageEvidence:'synthetic-road-inventory',crossing:'lincoln',direction:'ny_bound',
 crossingTime:{earliest:'2026-11-10T13:00:00Z',latest:'2026-11-10T13:00:00Z'},fleet:profile().official2026.fleet,entersCrz:true,
 zoneEntryTime:{earliest:'2026-11-10T13:00:00Z',latest:'2026-11-10T13:00:00Z'},dailyContext:{day:'2026-11-10',status:'first_entry',evidence:'synthetic-day-context-record'},
 creditEligibility:'eligible',creditEvidence:'synthetic-credit-entitlement',otherTolls:[],...extra};}
function addRoadCost(c,amount=225){
 const road=c.roads.find(r=>r.id==='lincoln_road1');road.kind='facility';road.facility='nj_turnpike';
 const facility={id:'nj_turnpike',kind:'table',authority:'njta',timeBasis:'entry',label:'Verified NJ road',evidence:'synthetic-njta-entry-exit-inventory',
 rates:[{entry:'lincoln_n1',exit:'lincoln_n2',vehicleClass:'1',tollPass:'US_NJ_EZPASSNJ',currency:'USD',amountCents:amount,days:[0,1,2,3,4,5,6],startMinute:0,endMinute:1440,
 evidence:'synthetic-road-rate-proof',version:'synthetic-road-rate-2026',...span}]};
 const index=c.facilities.findIndex(f=>f.id===facility.id);if(index<0)c.facilities.push(facility);else c.facilities[index]=facility;
 return facility;
}
module.exports={rectangle,corridor,span,portals,catalog,encode,googleRoute,profile,facts,addRoadCost};
