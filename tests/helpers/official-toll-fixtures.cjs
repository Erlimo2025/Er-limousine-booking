// Synthetic geometry and evidence ONLY. These are not operator attestations or live route surveys.
const e=require('../../services/toll-route-evidence');
const r=require('../../services/official-toll-rates');
const rectangle=(west,south,east,north)=>[[west,south],[east,south],[east,north],[west,north]];
const portals={lincoln:{nj:[-74.021,40.766],ny:[-74.004,40.758]},holland:{nj:[-74.037,40.728],ny:[-74.009,40.726]},gwb:{nj:[-73.963,40.853],ny:[-73.941,40.851]}};
function catalog(){return {version:e.VERSION,evidence:'synthetic-catalog-approval',crossings:Object.entries(portals).map(([id,p])=>({id,...p,
  corridor:rectangle(Math.min(p.nj[0],p.ny[0])-.0015,Math.min(p.nj[1],p.ny[1])-.0015,Math.max(p.nj[0],p.ny[0])+.0015,Math.max(p.nj[1],p.ny[1])+.0015),
  portalRadiusMeters:35,evidence:'synthetic-'+id+'-survey'})),crz:{polygon:rectangle(-74.006,40.70,-73.96,40.764),excluded:[],evidence:'synthetic-zone-survey'},routes:[]};}
function encode(points){let lat=0,lng=0,result='';function write(delta){let n=delta<0?-delta*2-1:delta*2;while(n>=32){result+=String.fromCharCode((n%32|32)+63);n=Math.floor(n/32);}result+=String.fromCharCode(n+63);}
 for(const p of points){const y=Math.round(p[1]*1e5),x=Math.round(p[0]*1e5);write(y-lat);write(x-lng);lat=y;lng=x;}return result;}
function googleRoute(crossing='lincoln',direction='ny_bound',amount=1375){
 const p=portals[crossing],points=[[p.nj[0]-.009,p.nj[1]+.004],[p.nj[0]-.0005,p.nj[1]+.0002],p.nj,p.ny,
  crossing==='gwb'?[p.ny[0]+.002,p.ny[1]]:[p.ny[0]+.01,p.ny[1]-.001]];
 if(direction==='nj_bound')points.reverse();
 return {distanceMeters:16093.44,duration:'1200s',staticDuration:'1200s',legs:[{steps:points.slice(1).map((p,i)=>({staticDuration:'300s',polyline:{encodedPolyline:encode([points[i],p])}}))}],
  ...(amount===undefined?{}:{travelAdvisory:{tollInfo:amount===null?{}:{estimatedPrice:[{currencyCode:'USD',units:String(Math.floor(amount/100)),nanos:amount%100*10000000}]}}})};
}
function manifest(c,route,origin,destination,extra={}){const hash=e.digest({crossings:c.crossings,crz:c.crz}),creditSource=extra.direction==='nj_bound'||extra.crossing==='gwb'?'none':extra.crossing||'lincoln';return {
 geometrySha256:e.geometry(route).hash,catalogSha256:hash,fleetSha256:e.digest(profile().official2026),originPlaceId:origin,destinationPlaceId:destination,
 crossing:'lincoln',direction:'ny_bound',crzEntries:1,allTollsReviewed:true,evidence:'synthetic-complete-road-inventory',
 validFrom:'2026-01-04T05:01:00Z',validUntil:'2027-01-01T04:59:59Z',crzCreditSource:creditSource,creditEligibility:creditSource==='none'?'ineligible':'eligible',creditEvidence:'synthetic-account-credit-review',otherTolls:[],...extra};}
function profile(vehicle='suv'){return {emissionType:'GASOLINE',tollPasses:['US_NJ_EZPASSNJ'],vehicleClass:'2Ax',commercialRatesVerified:false,congestionCoverageVerified:false,
 official2026:{vehicleKey:vehicle,fleet:{paClass:'1',axles:2,singleRearWheels:true,noTrailer:true,accountIssuer:'NJ',tagStatus:'mounted_readable',mtaPlan:'standard_daily',tlcLicensed:false,
 classEvidence:'synthetic-vehicle-class-record',tagEvidence:'synthetic-readable-tag-record',planEvidence:'synthetic-standard-daily-record',validUntil:'2027-01-01T05:00:00Z'},
 timing:{uncertaintySeconds:0,evidence:'synthetic-timing-calibration'},dailyPolicy:{kind:'assume_first_entry_estimate',operatorApproved:true,evidence:'synthetic-operator-estimate-policy'}}};}
function facts(extra={}){return {version:r.VERSION,routeVerified:true,coverageVerified:true,coverageEvidence:'synthetic-road-inventory',crossing:'lincoln',direction:'ny_bound',
 crossingTime:{earliest:'2026-11-10T13:00:00Z',latest:'2026-11-10T13:00:00Z'},fleet:profile().official2026.fleet,entersCrz:true,
 zoneEntryTime:{earliest:'2026-11-10T13:00:00Z',latest:'2026-11-10T13:00:00Z'},dailyContext:{day:'2026-11-10',status:'first_entry',evidence:'synthetic-day-context-record'},
 creditEligibility:'eligible',creditEvidence:'synthetic-credit-entitlement',otherTolls:[],...extra};}
module.exports={rectangle,portals,catalog,encode,googleRoute,manifest,profile,facts};
