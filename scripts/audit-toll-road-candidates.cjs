'use strict';

// Public infrastructure desk review only. Does not approve road/toll coverage,
// infer toll-free roads, call a provider, load .env or read private trip records.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.join(__dirname,'../docs/toll-acceptance/2026');
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
function meters(a,b){const rad=Math.PI/180,y1=a[1]*rad,y2=b[1]*rad,dy=y2-y1,dx=(b[0]-a[0])*rad;
 const n=Math.sin(dy/2)**2+Math.cos(y1)*Math.cos(y2)*Math.sin(dx/2)**2;return 12742000*Math.asin(Math.min(1,Math.sqrt(n)));}
const unique=items=>[...new Set(items)].sort((a,b)=>String(a).localeCompare(String(b)));
function summarize(features){
 const nodes=new Map();let length=0,missingProvenance=0;
 const vertex=(point,level)=>{const key=JSON.stringify([point,level]);if(!nodes.has(key))nodes.set(key,{neighbors:new Set(),degree:0});return key;};
 let west=Infinity,south=Infinity,east=-Infinity,north=-Infinity;
 for(const feature of features){
  const p=feature.properties,points=feature.geometry.coordinates;
  if(!p.SOURCE)missingProvenance++;
  for(const point of points){west=Math.min(west,point[0]);south=Math.min(south,point[1]);east=Math.max(east,point[0]);north=Math.max(north,point[1]);}
  for(let i=1;i<points.length;i++)length+=meters(points[i-1],points[i]);
  const a=vertex(points[0],p.ELEVTYP_F),b=vertex(points.at(-1),p.ELEVTYP_T);
  nodes.get(a).neighbors.add(b);nodes.get(b).neighbors.add(a);nodes.get(a).degree++;nodes.get(b).degree++;
 }
 let components=0;const visited=new Set();
 for(const key of nodes.keys())if(!visited.has(key)){components++;const pending=[key];visited.add(key);while(pending.length){for(const next of nodes.get(pending.pop()).neighbors)if(!visited.has(next)){visited.add(next);pending.push(next);}}}
 const xyLevels=new Map();for(const key of nodes.keys()){const [point,level]=JSON.parse(key),xy=JSON.stringify(point),levels=xyLevels.get(xy)||new Set();levels.add(level);xyLevels.set(xy,levels);}
 return {candidateFeatureCount:features.length,featureIds:features.map(f=>f.id),sourceLabels:unique(features.map(f=>f.properties.SOURCE)),
  sourceRoadIds:unique(features.map(f=>f.properties.SRI)),stateAttributePairs:unique(features.map(f=>f.properties.STATE_L+'/'+f.properties.STATE_R)),
  oneWayCodes:unique(features.map(f=>f.properties.ONEWAY)),relativeElevationPairs:unique(features.map(f=>f.properties.ELEVTYP_F+'/'+f.properties.ELEVTYP_T)),
  sourceFeatureBounds:features.length?[west,south,east,north]:null,centerlineLengthMeters:Math.round(length),
  endpointElevationComponents:components,degreeOneEndpoints:[...nodes.values()].filter(n=>n.degree===1).length,
  coincidentEndpointPositionsWithDifferentLevels:[...xyLevels.values()].filter(levels=>levels.size>1).length,missingPerFeatureSourceLabel:missingProvenance,
  topologyInterpretation:'Exact source endpoint and relative-elevation comparison within this labelled subset only. No snapping, corridor construction, turn/access approval or toll-free inference. Subset endpoints may connect to differently named roads.',
  runtimeApproval:'not_approved',approvedRoadLinks:0};
}
function audit(directory=root){
 const bytes=fs.readFileSync(path.join(directory,'candidate-nj-roads.geojson'),'utf8').replace(/\r\n/g,'\n'),data=JSON.parse(bytes);
 if(data.type!=='FeatureCollection'||data.activationApproved!==false||data.features.length!==3722)throw Error('Unexpected public candidate dataset');
 const nycBytes=fs.readFileSync(path.join(directory,'candidate-nyc-roads.geojson'),'utf8').replace(/\r\n/g,'\n'),nyc=JSON.parse(nycBytes);
 if(nyc.type!=='FeatureCollection'||nyc.activationApproved!==false||nyc.features.length!==409)throw Error('Unexpected NYC candidate dataset');
 const facilities=[['lincoln','Lincoln Tunnel'],['holland','Holland Tunnel'],['gwb','George Washington Bridge']].map(([id,label])=>({id,label,
  sourceIds:['njogis_centerlines','pa_tolls_2026','pa_guide_2026'],...summarize(data.features.filter(f=>f.properties.PRIMENAME===label)),
  reviewedFacts:['Labelled road geometry is present in the attributed NJOGIS export','The official PA schedule identifies this facility and its conditional direction/time tariffs'],
  unproved:['NY-side portals and complete approaches','Tube/level-specific connectivity and legal vehicle access','Corridor width and positional accuracy suitable for the runtime matcher','Actual selected Google route, vehicle class, readable tag and complete daily history']}));
 return {schema:'er-public-road-desk-review-v1',reviewedOn:'2026-11-01',engineCommit:'8cf3b47494560331f3e5e2f6aba5aa1a4c43251e',
  inputArtifact:'candidate-nj-roads.geojson',inputSha256:digest(bytes),sourceId:'njogis_centerlines',candidateFeatureCount:data.features.length,
  sourceReviewStatus:'provenance_and_attribute_desk_review_completed',approvedForActivation:false,approvedRoadLinks:0,approvedRuntimeFacilities:0,
  facilities,njtaCandidateSummary:summarize(data.features.filter(f=>(f.properties.PRIMENAME||'').startsWith('New Jersey Turnpike'))),
  sourceDomainReview:{sourceUrl:'https://services2.arcgis.com/XVOqAjTOJ5P6ngMu/arcgis/rest/services/Tran_road/FeatureServer/0',
   oneWay:{B:'both directions',FT:'source start to end',TF:'source end to start'},relativeElevation:{0:'at grade',1:'relative level 1',2:'relative level 2',3:'relative level 3'},
   limits:'Relative levels are intersection attributes, not surveyed Z heights or a verified upper/lower bridge mapping. Neither one-way codes nor state attributes establish a toll direction without the full path.'},
  supplementalNyc:{inputArtifact:'candidate-nyc-roads.geojson',inputSha256:digest(nycBytes),sourceIds:['nyc_oti_centerlines','nyc_open_data_terms'],candidateFeatureCount:nyc.features.length,
   coreFacilities:[['lincoln','LINCOLN TUNL'],['holland','HOLLAND TUNL'],['gwb','GEORGE WASHINGTON BRG']].map(([id,label])=>{
    const features=nyc.features.filter(f=>f.properties.full_street_name===label);
    return {id,sourceLabel:label,featureCount:features.length,featureIds:features.map(f=>f.id),trafficDirectionCodes:unique(features.map(f=>f.properties.trafdir)),
     fromLevelCodes:unique(features.map(f=>f.properties.from_level_code)),toLevelCodes:unique(features.map(f=>f.properties.to_level_code)),runtimeApproval:'not_approved'};
   }),
   reviewStatus:'source_provenance_reviewed_geometry_not_approved',approvedRoadLinks:0,
   limits:'Original NYC source geometry only; street labels and jurisdiction/level codes do not prove a matched driving path, inter-agency seam, toll class, legal vehicle access or CRZ exclusions. Selected labels include bus/pedestrian approaches that require separate review. No network connectors were fabricated.'},
  reviewDecision:'Approve no runtime links or facilities from these checks. Retain attributed NJ and NYC candidates for independent GIS/agency review. Complete approaches, portals, inter-agency seams, level connections, CRZ/exclusion polygons and legal-access evidence remain manual-review blockers.',
  operatorEvidence:{settledTransactions:'pending_user_records',vehicleClassification:'pending_user_confirmation',googleRouteGeometry:'pending_no_test_key_or_route_export'}};
}
if(require.main===module){try{const r=audit();console.log(JSON.stringify({status:r.sourceReviewStatus,inputSha256:r.inputSha256,approvedRoadLinks:0,
 facilities:r.facilities.map(f=>({id:f.id,candidates:f.candidateFeatureCount,states:f.stateAttributePairs,levels:f.relativeElevationPairs,endpointComponents:f.endpointElevationComponents})),
 supplementalNycCandidates:r.supplementalNyc.candidateFeatureCount,
 settledComparison:'pending_user_records',vehicleClass:'pending_user_confirmation'},null,2));}catch(_){console.error('Public road candidate audit could not complete; no approval issued.');process.exitCode=1;}}
module.exports={audit};
