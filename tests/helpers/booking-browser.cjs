'use strict';
// Isolated browser fixtures. Provider paths and fleet inputs are synthetic;
// these do not certify actual Google routes or the company's toll classification.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),{createRequire}=require('node:module');
const root=path.resolve(__dirname,'../..'),anchor=path.join(root,'tests/security-abuse.test.cjs');
const raw=fs.readFileSync(anchor,'utf8').replace('server.listen(0, "127.0.0.1", resolve)','server.listen(Number(env.PORT || 0), "127.0.0.1", resolve)');
const {harness}=new Function('require','__dirname',raw.slice(0,raw.indexOf('test("approved prices'))+'\nreturn {harness};')(createRequire(anchor),path.dirname(anchor));
const advanceFile=path.join(root,'tests/advance-toll-estimate.test.cjs'),advanceSource=fs.readFileSync(advanceFile,'utf8');
const base=new Function('require','__dirname',advanceSource.slice(0,advanceSource.indexOf("for(const id of ['lincoln'"))+'\nreturn {normal,profile,env,place,configureLocations};')(createRequire(advanceFile),path.dirname(advanceFile));
const reference=require('../../services/data/toll-estimate-reference-2026.json'),geometry=require('../../services/toll-route-evidence'),official=require('./official-toll-fixtures.cjs');
function route(c,amount){
 const f=reference.crossings.find(f=>f.id===c.crossing),raw=[...f.nj.flat(),...f.ny.flat()].sort((a,b)=>a[0]-b[0]);
 const points=raw.filter((p,i)=>!i||geometry.distance(raw[i-1],p)>1),street=reference.crzStreetWitnesses.filter(s=>s.name===c.street).flatMap(s=>s.paths.flat()).sort((a,b)=>a[0]-b[0]);
 if(street.length){const end=points.at(-1),first=street[0];for(let i=1;i<=8;i++)points.push([end[0]+(first[0]-end[0])*i/8,end[1]+(first[1]-end[1])*i/8]);points.push(...street);}
 if(c.direction==='nj_bound')points.reverse();
 const seconds=1200/(points.length-1);
 return {distanceMeters:100000,duration:'1500s',staticDuration:'1200s',legs:[{steps:points.slice(1).map((p,i)=>({staticDuration:seconds.toFixed(6)+'s',polyline:{encodedPolyline:official.encode([points[i],p])}}))}],travelAdvisory:{tollInfo:amount===null?{}:{estimatedPrice:[{currencyCode:'USD',units:String(Math.floor(amount/100)),nanos:amount%100*10000000}]}}};
}
const orange={id:'orange',pickup:'Orange, NJ',dropoff:'Times Square, Manhattan, NY',crossing:'lincoln',direction:'ny_bound',street:'W  42 ST'};
const cases=[
 {...orange,id:'interstate_estimate',expected:'estimated'},
 {...orange,id:'reverse',pickup:orange.dropoff,dropoff:orange.pickup,direction:'nj_bound',expected:'estimated'},
 {...orange,id:'included',pickup:'Newark, NJ',dropoff:'Lower Manhattan, NY',crossing:'holland',street:'CANAL ST',missingProfile:true,expected:'absorbed'},
 {...orange,id:'unknown',pickup:'Newark, NJ',dropoff:'Lower Manhattan, NY',crossing:'holland',street:'CANAL ST',unknown:true,expected:'absorbed'},
 {...orange,id:'same_state',dropoff:'Trenton, NJ',sameState:true,expected:'waived'},
 {...orange,id:'round_trip',tripType:'roundtrip',expected:'estimated'},
 {...orange,id:'hourly',tripType:'hourly'},
 {...orange,id:'ewr_special',pickup:'EWR',dropoff:'Manhattan',special:true,expected:'included'},
 {...orange,id:'regular_airport',pickup:'EWR',dropoff:'Manhattan',tripType:'airport',vehicle:'escalade',missingProfile:true,expected:'absorbed'},
 {...orange,id:'first15',promoCode:'FIRST15',account:true,expected:'estimated'},
 {...orange,id:'flag_off',disabled:true}
];
async function create(t,c=cases[0]){
 const probe=http.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
 const env={...base.env,PORT:String(port),SITE_URL:'http://127.0.0.1:'+port,ADMIN_TOLL_VALIDATION_ENABLED:'false'};
 if(c.missingProfile)env.TOLL_VEHICLE_PROFILES_JSON=undefined;if(c.disabled)env.ROUTE_TOLLS_ENABLED='false';
 const h=base.configureLocations(await harness(t,env));
 if(c.special)h.state.rejectTerminalCDetails=true;
 const input={...base.normal,pickup:c.pickup,dropoff:c.dropoff,vehicle:c.vehicle||'suv',date:'2026-11-10',time:'12:00',tripType:c.tripType||'oneway',returnDate:'2026-11-11',returnTime:'18:00',hours:'3.5',promoCode:c.promoCode||'',notes:'Please keep these requests'};
 for(const [key,label,state]of [['pickup',c.pickup,c.direction==='ny_bound'?'NJ':'NY'],['dropoff',c.dropoff,c.sameState?'NJ':c.direction==='ny_bound'?'NY':'NJ']])if(label!=='EWR')h.state.searchResults[label]=[base.place(state,'ChIJ_browser_mock_'+c.id+'_'+key,label)];
 h.state.routeResult=r=>{const reverse=c.tripType==='roundtrip'&&String(r.origin.placeId).includes('_dropoff'),trip=reverse?{...c,direction:'nj_bound'}:c;return route(trip,c.unknown?null:trip.direction==='nj_bound'?225:2500);};
 return {h,input,c};
}
module.exports={create,cases};
