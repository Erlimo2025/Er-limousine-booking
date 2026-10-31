// Offline candidate inspection only. Does not read .env, call Google or certify a route.
const fs=require('node:fs'),e=require('../services/toll-route-evidence');
try{
 const args=process.argv.slice(2),files={};
 if(args.length!==4)throw Error('arguments');
 for(let i=0;i<args.length;i+=2){if(!['--route','--coverage'].includes(args[i])||files[args[i]])throw Error('arguments');files[args[i]]=args[i+1];}
 function read(file){if(!file||fs.statSync(file).size>1000000)throw Error('input');return fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'');}
 const payload=JSON.parse(read(files['--route'])),route=payload.routes?.[0]||payload,g=e.geometry(route),catalog=e.coverage({OFFICIAL_TOLL_COVERAGE_JSON:read(files['--coverage'])});
 const gate=e.crossingEvents(g.points,catalog),entries=e.zoneEntries(g.points,catalog.crz);
 console.log(JSON.stringify({status:'candidate_requires_operator_review',geometrySha256:g.hash,catalogSha256:catalog.catalogHash,
  crossing:gate.crossing,direction:gate.direction,crzEntries:entries.length,points:g.points.length,
  note:'No classification, complete toll coverage, rate, credit, daily context or customer charge is certified by this output.'},null,2));
}catch(_){console.error('Unable to inspect route. Use --route <Google Routes JSON> --coverage <reviewed catalog JSON>; inputs must be complete, bounded JSON.');process.exitCode=1;}
