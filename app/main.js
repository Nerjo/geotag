(function(){
  "use strict";

  const $ = id => document.getElementById(id);
  const CONFIG=window.GEOTAG_CONFIG, RT=window.GeoTagRuntime;
  const dropzone=$('dropzone'), fileInput=$('fileInput'), cameraInput=$('cameraInput'), statusEl=$('status'),
        workspace=$('workspace'), cardsEl=$('cards'), wsCount=$('wsCount'),
        toast=$('toast'), overlay=$('overlay'), exportCanvas=$('exportCanvas');

  // Standalone build serves Leaflet/exifr/etc. from local vendored files. If a
  // file is missing or fails to parse, fail with a clear message instead of a
  // blank page.
  if(!CONFIG || !RT || typeof L==='undefined' || typeof exifr==='undefined'){
    statusEl.className='status show err';
    statusEl.innerHTML='<span>Couldn’t load the app libraries. Try reloading the page.</span>';
    return;
  }

  $('buildTag').textContent='V'+CONFIG.appVersion+' · '+CONFIG.buildId;
  let networkMode=CONFIG.privacyDefault==='online'?'online':'local';
  let processTotal=0, processDone=0;
  const processingQueue=new RT.TaskQueue({concurrency:CONFIG.processingConcurrency||2});
  const geocodeQueue=new RT.TaskQueue({concurrency:1,minIntervalMs:CONFIG.geocoder.minIntervalMs||1100});

  function updateBatchProgress(){
    const wrap=$('batchProgressWrap'), bar=$('batchProgress'), text=$('batchProgressText');
    if(processDone>=processTotal){ wrap.hidden=true; processTotal=0; processDone=0; return; }
    wrap.hidden=false; bar.max=Math.max(1,processTotal); bar.value=processDone;
    text.textContent='Processing '+processDone+'/'+processTotal;
  }

  function queuePhotoTask(task,signal){
    processTotal++; updateBatchProgress();
    return processingQueue.enqueue(task,{signal}).finally(()=>{ processDone++; updateBatchProgress(); });
  }

  const PIN_SVG = encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="34" height="44" viewBox="0 0 34 44">'+
    '<path d="M17 1C8.16 1 1 8.16 1 17c0 11.5 16 26 16 26s16-14.5 16-26C33 8.16 25.84 1 17 1z" fill="#ef5d12" stroke="#1a1c1e" stroke-width="1.6"/>'+
    '<circle cx="17" cy="17" r="6.4" fill="#1a1c1e"/><circle cx="17" cy="17" r="2.4" fill="#fff"/></svg>'
  );
  // Direction cone: apex at (60,60), opening "up" (= north, 0°). Drawn into a
  // 120×120 box that is positioned so its apex sits on the pin's tip; rotating
  // the holder by the heading then points the cone where the camera faced.
  const CONE_SVG =
    '<svg width="120" height="120" viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg">'+
    '<path d="M60 60 L33 13 A54 54 0 0 1 87 13 Z" fill="rgba(239,93,18,.30)" '+
    'stroke="rgba(197,68,5,.85)" stroke-width="2" stroke-linejoin="round"/></svg>';
  const pinIcon = L.divIcon({
    className:'geo-pin',
    html:'<div class="geo-pin-wrap">'+
         '<span class="geo-cone-holder" style="display:none">'+CONE_SVG+'</span>'+
         '<img src="data:image/svg+xml,'+PIN_SVG+'" width="34" height="44" alt="">'+
         '</div>',
    iconSize:[34,44], iconAnchor:[17,44], popupAnchor:[0,-40]
  });

  /* ---------- shared ui helpers ---------- */
  function setStatus(msg,type){
    statusEl.className='status show '+(type||'ok');
    statusEl.setAttribute('role',type==='err'?'alert':'status');
    statusEl.innerHTML=(type==='loading'?'<span class="spinner"></span>':'')+'<span>'+msg+'</span>';
  }
  function clearStatus(){ statusEl.className='status'; statusEl.innerHTML=''; }
  function ping(text){
    toast.textContent=text||'Copied';
    toast.classList.add('show');
    clearTimeout(ping._t);
    ping._t=setTimeout(()=>toast.classList.remove('show'),1300);
  }
  function copyText(t,label){ navigator.clipboard.writeText(t).then(()=>ping((label||'Copied')+' ✓')).catch(()=>ping('Copy failed')); }
  const isPhone = ()=>window.matchMedia('(max-width:760px)').matches;
  const esc = s => String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const currentMapType = ()=>{
    const selected=document.querySelector('input[name="mapType"]:checked');
    if(selected&&CONFIG.providers[selected.value]&&CONFIG.providers[selected.value].enabled&&CONFIG.providers[selected.value].url) return selected.value;
    return Object.keys(CONFIG.providers).find(key=>CONFIG.providers[key].enabled&&CONFIG.providers[key].url);
  };

  function validImage(f){ return f && (f.type.startsWith('image/') || /\.(heic|heif)$/i.test(f.name)); }

  // Draw `img` into the dest rect using COVER fit (uniform scale + centre-crop).
  function drawCover(ctx,img,dx,dy,dw,dh){
    const iw=img.width, ih=img.height;
    if(!iw||!ih){ return; }
    const dAR=dw/dh, iAR=iw/ih;
    let sx,sy,sw,sh;
    if(iAR>dAR){ sh=ih; sw=ih*dAR; sx=(iw-sw)/2; sy=0; }   // source too wide -> crop sides
    else       { sw=iw; sh=iw/dAR; sx=0; sy=(ih-sh)/2; }   // source too tall -> crop top/bottom
    ctx.drawImage(img, sx,sy,sw,sh, dx,dy,dw,dh);
  }

  // Greedy word-wrap for canvas text. Reports expand to fit every line; content
  // is never silently truncated.
  function wrapLines(text, maxW, font, maxLines){
    text=(text||'').replace(/\s+/g,' ').trim();
    if(!text) return [];
    const c=wrapLines._ctx||(wrapLines._ctx=document.createElement('canvas').getContext('2d'));
    c.font=font;
    const words=text.split(' '), lines=[]; let cur='';
    for(const w of words){
      const test=cur?cur+' '+w:w;
      if(c.measureText(test).width<=maxW || !cur){ cur=test; }
      else{ lines.push(cur); cur=w; }
    }
    if(cur) lines.push(cur);
    const fitted=[];
    for(const line of lines){
      if(c.measureText(line).width<=maxW){fitted.push(line);continue;}
      let chunk='';
      for(const char of line){
        if(chunk&&c.measureText(chunk+char).width>maxW){fitted.push(chunk);chunk=char;}
        else chunk+=char;
      }
      if(chunk)fitted.push(chunk);
    }
    lines.splice(0,lines.length,...fitted);
    if(Number.isFinite(maxLines) && lines.length>maxLines){
      let last=lines[maxLines-1]+'…';
      while(c.measureText(last).width>maxW && last.length>1) last=last.slice(0,-2)+'…';
      lines.length=maxLines; lines[maxLines-1]=last;
    }
    return lines;
  }

  /* ---------- coordinate formatting ---------- */
  function toDMS(value,isLat){
    const dir = value>=0 ? (isLat?'N':'E') : (isLat?'S':'W');
    const abs=Math.abs(value);
    const d=Math.floor(abs), mFloat=(abs-d)*60, m=Math.floor(mFloat), s=(mFloat-m)*60;
    return d+'° '+String(m).padStart(2,'0')+"' "+s.toFixed(2)+'" '+dir;
  }
  function compass(deg){
    const dirs=['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
    return dirs[Math.round(((deg%360)/22.5))%16];
  }

  /* ---------- GPS accuracy / fix-age helpers ---------- */
  const ACC_WARN_M=15;    // horizontal accuracy beyond this (m) gets a "verify pin" warning
  const STALE_FIX_MIN=10; // GPS fix older than the photo by this many minutes may be cached

  function fmtAcc(m){ return m<10 ? m.toFixed(1).replace(/\.0$/,'') : String(Math.round(m)); }

  // GPSHPositioningError is normally a plain number, but stay defensive about
  // rational pairs and string values from other writers.
  function parseAccuracy(v){
    if(v==null) return null;
    if(typeof v==='number') return isFinite(v)&&v>=0 ? v : null;
    if(Array.isArray(v)&&v.length===2&&v[1]) return v[0]/v[1];
    const n=parseFloat(v);
    return isFinite(n)&&n>=0 ? n : null;
  }

  // '+05:30' | '-06:00' | 'Z' -> minutes east of UTC, else null
  function parseUtcOffsetMin(s){
    if(typeof s!=='string') return null;
    s=s.trim();
    if(s==='Z') return 0;
    const m=/^([+-])(\d{1,2}):?(\d{2})$/.exec(s);
    if(!m) return null;
    const v=(+m[2])*60+(+m[3]);
    return v>18*60 ? null : (m[1]==='-' ? -v : v);
  }

  function formatExifWallTime(date){
    if(!(date instanceof Date)||isNaN(date)) return '';
    const pad=value=>String(value).padStart(2,'0');
    return date.getFullYear()+'-'+pad(date.getMonth()+1)+'-'+pad(date.getDate())+'T'+
      pad(date.getHours())+':'+pad(date.getMinutes())+':'+pad(date.getSeconds());
  }

  // Minutes the GPS fix predates the capture, or null when not computable.
  // DateTimeOriginal is local wall-clock while the GPS stamps are UTC, so the
  // comparison is only attempted when OffsetTimeOriginal pins down the zone.
  function gpsFixAgeMin(exif){
    const d=exif.DateTimeOriginal;
    if(!(d instanceof Date)||isNaN(d)) return null;
    const offMin=parseUtcOffsetMin(exif.OffsetTimeOriginal);
    if(offMin==null) return null;
    const ds=exif.GPSDateStamp, ts=exif.GPSTimeStamp;
    if(typeof ds!=='string'||ts==null) return null;
    const dm=/^(\d{4})[:-](\d{2})[:-](\d{2})$/.exec(ds.trim());
    if(!dm) return null;
    const parts=(Array.isArray(ts)?ts:String(ts).split(':')).map(Number);
    if(parts.length!==3||parts.some(n=>!isFinite(n))) return null;
    const gpsUTC=Date.UTC(+dm[1],+dm[2]-1,+dm[3],parts[0],parts[1],parts[2]);
    const photoUTC=Date.UTC(d.getFullYear(),d.getMonth(),d.getDate(),
                            d.getHours(),d.getMinutes(),d.getSeconds())-offMin*60000;
    return (photoUTC-gpsUTC)/60000;
  }

  /* ---------- readout html helpers ---------- */
  function field(k,v,copyVal,cls,key){
    return '<div class="field"><div class="k">'+esc(k)+'</div><div class="v '+(cls||'')+(key?(' '+key):'')+'">'+
      '<span>'+esc(v)+'</span>'+(copyVal?copyBtn(copyVal,k):'')+'</div></div>';
  }
  function copyBtn(val,label){
    return '<button class="copy" data-copy="'+esc(val)+'" data-label="'+esc(label||'Copied')+'" title="Copy" aria-label="Copy '+esc(label||'')+'">'+
      '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg></button>';
  }

  /* ---------- map tiles ---------- */
  function tileLayerFor(type){
    const provider=CONFIG.providers[type];
    if(!provider || !provider.enabled || !provider.url) throw new Error('Map provider is not configured');
    return L.tileLayer(provider.url,{maxZoom:provider.maxZoom||19,crossOrigin:true,attribution:provider.attributionHtml||provider.attributionText});
  }
  // Attribution string baked into exported report images (tile-provider terms
  // require visible credit on published maps, including PNG exports).
  function attributionFor(type){
    const provider=CONFIG.providers[type];
    return provider&&provider.attributionText?provider.attributionText:'Provider attribution unavailable';
  }

  function drawProviderAttribution(ctx,type,x,y,width){
    const attr=attributionFor(type);
    ctx.save();
    ctx.textAlign='left';ctx.font='9px "IBM Plex Mono", monospace';
    const tw=Math.min(ctx.measureText(attr).width,width-12);
    ctx.fillStyle='rgba(255,255,255,.9)';ctx.fillRect(x+width-tw-12,y-18,tw+12,18);
    ctx.fillStyle='#292c30';ctx.fillText(attr,x+width-tw-6,y-6,tw);
    ctx.restore();
  }

  function drawNavigationQr(ctx,text,right,bottom,targetSize=128){
    const code=qrcode(0,'M');
    code.addData(text,'Byte');code.make();
    const count=code.getModuleCount(),quiet=4;
    const cell=Math.max(2,Math.floor(targetSize/(count+quiet*2)));
    const size=(count+quiet*2)*cell,x=right-size,y=bottom-size;
    ctx.save();ctx.fillStyle='#fff';ctx.fillRect(x,y,size,size);ctx.fillStyle='#111';
    for(let row=0;row<count;row++)for(let col=0;col<count;col++){
      if(code.isDark(row,col))ctx.fillRect(x+(col+quiet)*cell,y+(row+quiet)*cell,cell,cell);
    }
    ctx.fillStyle='#1a1c1e';ctx.font='600 9px "IBM Plex Mono", monospace';ctx.textAlign='center';
    ctx.fillText('SCAN TO NAVIGATE',x+size/2,bottom+14);
    ctx.restore();
  }

  /* ---------- on-demand vendor libraries ----------
     Export-only libraries are not part of the startup payload; each loads once,
     the first time a feature needs it. The service worker precaches them, so
     installed users get them offline too. A failed load is retryable. */
  const vendorLoads={};
  function loadVendor(src,ready,unavailable){
    if(ready()) return Promise.resolve();
    if(vendorLoads[src]) return vendorLoads[src];
    vendorLoads[src]=new Promise((resolve,reject)=>{
      const script=document.createElement('script');
      const fail=()=>{ delete vendorLoads[src]; reject(new Error(unavailable)); };
      script.src=src;
      script.onload=()=>ready()?resolve():fail();
      script.onerror=fail;
      document.head.appendChild(script);
    });
    return vendorLoads[src];
  }
  const loadQrLibrary=()=>loadVendor('vendor/qrcode/qrcode.js',()=>typeof qrcode!=='undefined','QR generator unavailable');
  const loadMapCapture=()=>loadVendor('vendor/html2canvas/html2canvas.min.js',()=>typeof html2canvas!=='undefined','Map capture library unavailable');
  const loadDocxLibrary=()=>loadVendor('vendor/docx/docx.iife.js',()=>typeof docx!=='undefined','Word library unavailable');
  const loadHeicLibrary=()=>loadVendor('vendor/heic2any/heic2any.min.js',()=>typeof heic2any!=='undefined','HEIC converter unavailable');

  /* ---------- HEIC / HEIF ---------- */
  function isHeicFile(f){
    return /\.(heic|heif)$/i.test(f.name) || f.type==='image/heic' || f.type==='image/heif';
  }
  async function toDisplayable(file,onStatus){
    let display=file;
    if(isHeicFile(file)){
      await loadHeicLibrary();
      if(onStatus) onStatus('Converting HEIC…','loading');
      try{
        const blob=await heic2any({blob:file,toType:'image/jpeg',quality:0.9});
        display=new File([Array.isArray(blob)?blob[0]:blob],file.name.replace(/\.(heic|heif)$/i,'.jpg'),{type:'image/jpeg'});
      }catch(e){
        console.error('heic2any conversion failed',e);
        throw new Error('Could not convert this HEIC photo — export it as JPEG and upload that instead.');
      }
    }
    if(typeof createImageBitmap!=='function') return display;
    const bitmap=await createImageBitmap(display);
    try{
      if(bitmap.width*bitmap.height>CONFIG.maxPixels)
        throw new Error('This image exceeds the '+Math.round(CONFIG.maxPixels/1000000)+' megapixel safety limit. Resize it before adding.');
      const maxEdge=2600,scale=Math.min(1,maxEdge/Math.max(bitmap.width,bitmap.height));
      if(scale===1) return display;
      if(onStatus) onStatus('Creating bounded preview…','loading');
      const canvas=document.createElement('canvas');canvas.width=Math.round(bitmap.width*scale);canvas.height=Math.round(bitmap.height*scale);
      canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height);
      const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',.9));
      return new File([blob],display.name.replace(/\.(png|heic|heif)$/i,'.jpg'),{type:'image/jpeg'});
    }finally{bitmap.close();}
  }

  /* ---------- centrally configurable reverse-geocode queue ---------- */
  function queueGeocode(fn,signal){
    if(networkMode!=='online' || !CONFIG.geocoder.enabled || !CONFIG.geocoder.url) return Promise.resolve();
    return geocodeQueue.enqueue(fn,{signal}).catch(error=>{
      if(error&&error.name!=='AbortError') console.warn('geocode',error);
    });
  }

  /* ---------- shared export modal ---------- */
  let currentBlob=null, currentName='geotag.png', currentShareText='', currentRecordId=null, reportLastFocus=null;
  // buildExport draws onto the one shared #exportCanvas, so only a single
  // export (button or Word batch) may run at a time.
  let exportBusy=false;
  async function openExport(photo,btn,withCaption=true){
    if(exportBusy){ ping('Another export is still running'); return; }
    exportBusy=true;
    btn=btn||photo.buildBtn;
    const label=btn.innerHTML;
    btn.disabled=true; btn.innerHTML='Rendering…';
    try{
      const blob=await photo.buildExport(withCaption);
      if(!blob) return;
      currentBlob=blob; currentName=photo.filename(withCaption?'':'_nocaption');
      currentRecordId=photo.getRecord().recordId;
      currentShareText=photo.shareText();
      $('shareDetails').value=currentShareText;
      $('exportHint').textContent=withCaption
        ?'Side-by-side photo & map with a coordinate caption — ready for your inspection report.'
        :'Side-by-side photo & map, no coordinate caption — ready for copying.';
      const shareBtn=$('shareImgBtn');
      shareBtn.hidden = !(navigator.canShare && navigator.canShare({files:[new File([blob],currentName,{type:'image/png'})]}));
      reportLastFocus=document.activeElement;
      if(!overlay.open) overlay.showModal();
    }catch(e){ console.error('export',e); ping('Could not build report'); }
    finally{ exportBusy=false; btn.disabled=false; btn.innerHTML=label; }
  }

  /* ---------- photo editor — iPhone-Photos-style crop/straighten + markup ----------
     Crop model: the crop rectangle lives in "rotated space" (image space rotated
     by the straighten angle about the image centre). Pinch/pan/dial/wheel keep
     the frame fixed on screen and move the image beneath it; dragging a corner
     or edge moves the frame itself and the view re-fits on release — the same
     interaction grammar as the iOS Photos editor. 90° rotation and mirroring
     bake losslessly into the working bitmap at once; the straighten angle and
     crop bake once per crop session (a single undo step). Markup strokes bake
     per stroke with JPEG-snapshot undo. Applying hands the card a new blob —
     the original file and its EXIF/GPS are never touched. */
  const editor=window.createGeoTagEditor({$,ping,isPhone});

  /* ---------- per-photo card ---------- */
  let nextId=0;
  const photos=[];

  function makeRecordId(sequence){
    const bytes=new Uint8Array(3);
    if(globalThis.crypto&&globalThis.crypto.getRandomValues) globalThis.crypto.getRandomValues(bytes);
    else bytes.forEach((_,index)=>{bytes[index]=Math.floor(Math.random()*256);});
    const suffix=[...bytes].map(value=>value.toString(16).padStart(2,'0')).join('').toUpperCase();
    return 'GT-'+new Date().toISOString().slice(0,10).replace(/-/g,'')+'-'+String(sequence).padStart(4,'0')+'-'+suffix;
  }

  function updateCount(){
    wsCount.textContent = photos.length ? (photos.length+(photos.length===1?' photo':' photos')) : '';
  }

  function configuredProviders(){
    return Object.entries(CONFIG.providers).filter(([,provider])=>provider.enabled&&provider.url);
  }

  function updatePrivacyControls(){
    document.querySelectorAll('input[name="privacyMode"]').forEach(input=>{
      input.checked=input.value===networkMode;
      input.closest('label').classList.toggle('active',input.checked);
    });
    $('mapTypes').hidden=networkMode!=='online';
    const provider=CONFIG.providers[currentMapType()];
    $('privacySummary').textContent=networkMode==='local'
      ?'GeoTag makes no automatic map or address request. Reports contain a local coordinate panel.'
      :'Online for this session: '+(provider?provider.label:'configured provider')+'. '+
       (CONFIG.geocoder.enabled?CONFIG.geocoder.label+' may receive exact coordinates.':'Address lookup remains disabled.');
  }

  function setPrivacyMode(mode){
    networkMode=mode==='online'?'online':'local';
    if(networkMode==='local') geocodeQueue.cancelPending('Privacy mode changed');
    updatePrivacyControls();
    photos.forEach(photo=>{
      if(networkMode==='local') photo.cancelNetwork();
      photo.setNetworkMode();
    });
  }

  function providerDisclosure(){
    const providers=configuredProviders();
    const items=providers.map(([,provider])=>'<li><strong>'+esc(provider.label)+'</strong>: '+esc(provider.disclosure)+'</li>');
    items.push('<li><strong>'+esc(CONFIG.geocoder.label)+'</strong>: '+esc(CONFIG.geocoder.disclosure)+'</li>');
    return '<p>Online mode is session-only. It sends location-derived requests only after you confirm.</p><ul>'+items.join('')+'</ul>';
  }

  configuredProviders().forEach(([key,provider])=>{
    const label=document.querySelector('#mapTypes label[data-type="'+key+'"]');
    if(label) label.querySelector('span').textContent=provider.label.replace(/ Standard$/,'');
  });
  document.querySelectorAll('#mapTypes label').forEach(label=>{
    const provider=CONFIG.providers[label.dataset.type];
    if(!provider||!provider.enabled||!provider.url) label.hidden=true;
  });
  const firstProvider=configuredProviders()[0];
  if(firstProvider){
    const input=document.querySelector('input[name="mapType"][value="'+firstProvider[0]+'"]');
    if(input){input.checked=true;input.closest('label').classList.add('active');}
  }
  $('privacyDisclosure').innerHTML=providerDisclosure();
  updatePrivacyControls();

  function createPhoto(file){
    const id=++nextId;
    const recordId=makeRecordId(id);
    const card=document.createElement('section');
    card.className='card';
    card.setAttribute('aria-labelledby','card-title-'+id);
    card.innerHTML=
      '<div class="card-bar">'+
        '<span class="card-num">'+recordId+'</span>'+
        '<span class="card-title" id="card-title-'+id+'">'+esc(file.name)+'</span>'+
        '<button class="card-remove" title="Remove photo" aria-label="Remove photo">✕</button>'+
      '</div>'+
      '<div class="canvas-row">'+
        '<div class="pane">'+
          '<div class="pane-head"><span><span class="dot"></span>Photo</span>'+
            '<span class="headright">'+
            '<span class="moved-tag editedTag" style="display:none">edited</span>'+
            '<button class="pane-btn cedit" disabled title="Crop, rotate, straighten & markup" aria-label="Edit photo">✎ Edit</button>'+
            '<span class="dimReadout">—</span></span></div>'+
          '<img class="cphoto" alt="Uploaded photo preview" decoding="async" loading="lazy">'+
        '</div>'+
        '<div class="pane map-pane">'+
          '<div class="pane-head"><span><span class="dot"></span>Location</span><span class="accReadout" style="display:none"></span><span class="zoomReadout">—</span></div>'+
          '<div class="cmap"></div>'+
        '</div>'+
      '</div>'+
      '<div class="creadout"></div>'+
      '<div class="status card-status" role="status" aria-live="polite"></div>'+
      '<div class="card-actions">'+
        '<button class="btn accent cbuild" disabled>⧉ Build report image</button>'+
        '<button class="btn cbuildplain" disabled>⧉ Build image (no caption)</button>'+
      '</div>';
    cardsEl.appendChild(card);

    const photoImg=card.querySelector('.cphoto'),
          mapEl=card.querySelector('.cmap'),
          mapPane=card.querySelector('.map-pane'),
          canvasRow=card.querySelector('.canvas-row'),
          readoutEl=card.querySelector('.creadout'),
          dimEl=card.querySelector('.dimReadout'),
          zoomEl=card.querySelector('.zoomReadout'),
          accEl=card.querySelector('.accReadout'),
          statusC=card.querySelector('.card-status'),
          buildBtn=card.querySelector('.cbuild'),
          buildPlainBtn=card.querySelector('.cbuildplain'),
          removeBtn=card.querySelector('.card-remove'),
          editBtn=card.querySelector('.cedit'),
          editedTag=card.querySelector('.editedTag');
    const q=sel=>readoutEl.querySelector(sel);

    let map=null, marker=null, accCircle=null, displaySrc=null, originalSrc=null, ro=null, metadata={}, mapObserver=null;
    const lifetimeController=new AbortController();
    let networkController=new AbortController(), geocodeController=new AbortController(), mapVisible=!('IntersectionObserver' in window), mapPending=false;
    const state={lat:null,lon:null,heading:null,caption:'',captionEdited:false,
                 address:null,pinMoved:false,sourceLat:null,sourceLon:null,
                 adjustmentReason:'',locationSource:'none',recordId,sourceFilename:file.name,
                 accuracy:null,gpsStaleMin:null,capturedAt:'',timezone:'',mapComplete:null};

    function cstat(msg,type){
      statusC.className='status card-status show '+(type||'ok');
      statusC.setAttribute('role',type==='err'?'alert':'status');
      statusC.innerHTML=(type==='loading'?'<span class="spinner"></span>':'')+'<span>'+esc(msg)+'</span>';
    }
    function gpsStatus(){
      if(state.accuracy!=null && state.accuracy>ACC_WARN_M)
        cstat('Location ready — low accuracy ±'+fmtAcc(state.accuracy)+' m, verify it','warn');
      else cstat('Location ready · '+state.locationSource,'ok');
    }

    /* ----- load pipeline ----- */
    async function load(signal){
      const checkActive=()=>{
        if((signal&&signal.aborted)||!card.isConnected) throw new DOMException('Photo processing cancelled','AbortError');
      };
      cstat('Reading image…','loading');
      try{
        const displayFile=await toDisplayable(file,cstat);
        checkActive();
        displaySrc=URL.createObjectURL(displayFile);
        await new Promise((res,rej)=>{
          const cleanup=()=>{if(signal)signal.removeEventListener('abort',abort);};
          const abort=()=>{photoImg.onload=null;photoImg.onerror=null;photoImg.removeAttribute('src');cleanup();rej(new DOMException('Photo processing cancelled','AbortError'));};
          photoImg.onload=()=>{cleanup();dimEl.textContent=photoImg.naturalWidth+' × '+photoImg.naturalHeight+' px';res();};
          photoImg.onerror=error=>{cleanup();rej(error);};
          if(signal)signal.addEventListener('abort',abort,{once:true});
          photoImg.src=displaySrc;
        });
        checkActive();
        originalSrc=displaySrc;   // kept for the editor's "Restore original"
        editBtn.disabled=false;

        if(photoImg.naturalWidth*photoImg.naturalHeight>CONFIG.maxPixels)
          throw new Error('This image exceeds the '+Math.round(CONFIG.maxPixels/1000000)+' megapixel safety limit. Resize it before adding.');

        // EXIF is read from the ORIGINAL file (conversion can drop metadata)
        let exif={}, gps=null;
        try{
          const [parsed,g]=await Promise.all([
            exifr.parse(file,{tiff:true,exif:true,gps:true}).catch(()=>({})),
            exifr.gps(file).catch(()=>null)
          ]);
          exif=parsed||{}; gps=g; metadata=exif;
        }catch(_){}
        checkActive();

        const captured=exif.DateTimeOriginal||exif.CreateDate||exif.ModifyDate;
        state.capturedAt=formatExifWallTime(captured);
        state.timezone=typeof exif.OffsetTimeOriginal==='string'?exif.OffsetTimeOriginal:'';

        if(!gps || gps.latitude==null){
          cstat('No GPS data found. Enter coordinates or explicitly use this device’s location.','warn');
          renderReadout(exif,null);
          updateMapMode();
          buildBtn.disabled=true;
          return;
        }

        state.lat=gps.latitude; state.lon=gps.longitude;
        state.sourceLat=state.lat; state.sourceLon=state.lon; state.locationSource='photo EXIF';
        state.heading=(typeof exif.GPSImgDirection==='number')?exif.GPSImgDirection:null;
        state.accuracy=parseAccuracy(exif.GPSHPositioningError);
        state.gpsStaleMin=gpsFixAgeMin(exif);
        if(state.accuracy!=null){
          accEl.style.display='';
          accEl.textContent='±'+fmtAcc(state.accuracy)+' m';
          if(state.accuracy>ACC_WARN_M) accEl.classList.add('bad');
        }
        gpsStatus();
        renderReadout(exif,gps);
        updateMapMode();
        buildBtn.disabled=false; buildPlainBtn.disabled=false;
        scheduleGeocode();
      }catch(err){
        if(err&&err.name==='AbortError') return;
        console.error(err);
        // conversion errors carry a specific, actionable message — show it
        const msg=err&&err.message ? err.message : 'Could not process this image. Try another file.';
        cstat(msg,'err');
      }
    }

    /* ----- accessible readout and manual location ----- */
    function renderReadout(exif){
      const rows=[];
      const dt=exif.DateTimeOriginal||exif.CreateDate||exif.ModifyDate;
      const dateStr=dt instanceof Date && !isNaN(dt)
        ? dt.toLocaleString(undefined,{year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})+(state.timezone?' '+state.timezone:' · timezone unavailable')
        : '—';
      const camera=[exif.Make,exif.Model].filter(Boolean).join(' ').trim()||'—';
      rows.push(field('Record ID',state.recordId,state.recordId));
      rows.push(field('Source file',state.sourceFilename));
      rows.push(
        '<div class="field"><div class="k">Captured'+
        (state.gpsStaleMin!=null && state.gpsStaleMin>STALE_FIX_MIN
          ? ' <span class="moved-tag">gps fix '+Math.round(state.gpsStaleMin)+' min older</span>' : '')+
        '</div><div class="v"><span>'+esc(dateStr)+'</span></div></div>'
      );
      rows.push(field('Camera',camera));

      if(state.lat==null){
        rows.push(
          '<div class="field wide"><div class="manual-location"><h3>Add a location</h3>'+
          '<p>Paste decimal coordinates or explicitly use this device’s current location.</p>'+
          '<div class="coordinate-edit">'+
          '<label for="manual-lat-'+id+'">Latitude<input id="manual-lat-'+id+'" class="manualLat" inputmode="decimal" autocomplete="off" placeholder="53.5461"></label>'+
          '<label for="manual-lon-'+id+'">Longitude<input id="manual-lon-'+id+'" class="manualLon" inputmode="decimal" autocomplete="off" placeholder="-113.4938"></label>'+
          '<button class="btn accent sm manualApply" type="button">Use coordinates</button></div>'+
          '<div class="manual-actions"><button class="btn ghost sm useDeviceLocation" type="button">Use current device location</button></div>'+
          '</div></div>'
        );
      }else{
        const latDec=RT.formatCoordinate(state.lat,state.accuracy), lonDec=RT.formatCoordinate(state.lon,state.accuracy);
        const pair=latDec+', '+lonDec;
        rows.push(field('Latitude',latDec+'°',latDec,'span2','f-lat'));
        rows.push(field('Longitude',lonDec+'°',lonDec,'span2','f-lon'));
        rows.push(field('Latitude (DMS)',toDMS(state.lat,true),null,'span2','f-latdms'));
        rows.push(field('Longitude (DMS)',toDMS(state.lon,false),null,'span2','f-londms'));
        rows.push(field('Altitude',(typeof exif.GPSAltitude==='number')?exif.GPSAltitude.toFixed(1)+' m':'—'));
        rows.push('<div class="field"><div class="k">Accuracy'+
          (state.accuracy!=null&&state.accuracy>ACC_WARN_M?' <span class="moved-tag">low</span>':'')+
          '</div><div class="v"><span>'+(state.accuracy!=null?'±'+fmtAcc(state.accuracy)+' m':'Not recorded · precision limited')+'</span></div></div>');
        const hv=state.heading!=null?(' value="'+Math.round(state.heading)+'"'):'';
        const hc=state.heading!=null?('° '+compass(state.heading)):'set direction';
        rows.push('<div class="field"><div class="k"><label for="heading-'+id+'">Heading</label></div><div class="v"><div class="hdg-edit">'+
          '<input id="heading-'+id+'" class="headingField" type="number" min="0" max="359" step="1" inputmode="numeric" placeholder="—"'+hv+' aria-describedby="heading-compass-'+id+'">'+
          '<span id="heading-compass-'+id+'" class="compass headingCompass">'+hc+'</span></div></div></div>');
        rows.push('<div class="field wide"><div class="k">Coordinates <span class="moved-tag movedTag"'+(state.pinMoved?'':' hidden')+'>adjusted</span></div>'+
          '<div class="v"><span class="coordPair">'+pair+'</span>'+copyBtn(pair)+'</div></div>');
        rows.push('<div class="field wide"><div class="k">Keyboard coordinate correction</div><div class="coordinate-edit">'+
          '<label for="edit-lat-'+id+'">Latitude<input id="edit-lat-'+id+'" class="editLat" inputmode="decimal" value="'+state.lat+'"></label>'+
          '<label for="edit-lon-'+id+'">Longitude<input id="edit-lon-'+id+'" class="editLon" inputmode="decimal" value="'+state.lon+'"></label>'+
          '<button class="btn ghost sm applyCoords" type="button">Apply</button></div>'+
          '<div class="adjustment-controls"><label for="adjust-reason-'+id+'">Adjustment reason<input id="adjust-reason-'+id+'" class="adjustmentReason" maxlength="180" value="'+esc(state.adjustmentReason)+'" placeholder="Required when coordinates are changed"></label>'+
          '<button class="btn ghost sm resetLocation" type="button"'+(state.pinMoved?'':' hidden')+'>Reset original</button></div></div>');
        rows.push('<div class="field wide"><div class="k"><label for="caption-'+id+'">Caption</label></div>'+
          '<textarea id="caption-'+id+'" class="cap-input captionField" rows="3" maxlength="1200" aria-describedby="caption-help-'+id+'" placeholder="'+
          (networkMode==='online'&&CONFIG.geocoder.enabled?'Looking up address… (or type your own caption)':'Type a complete caption')+'">'+esc(state.caption||'')+'</textarea>'+
          '<span class="provider-note" id="caption-help-'+id+'">Up to 1,200 characters; every line is included in the report.</span></div>');
        rows.push('<div class="field wide"><div class="k">Open in</div><div class="v"><div class="maplinks">'+
          '<a class="maplink geoLink" href="#">▷ Device maps</a>'+
          '<a class="maplink gmapLink" target="_blank" rel="noopener" href="#">▷ Google Maps</a>'+
          '<a class="maplink amapLink" target="_blank" rel="noopener" href="#">▷ Apple Maps</a>'+
          '<a class="maplink osmLink" target="_blank" rel="noopener" href="#">▷ OpenStreetMap</a>'+
          '</div><span class="provider-note">Location source: '+esc(state.locationSource)+'</span></div></div>');
      }

      readoutEl.innerHTML='<div class="readout-grid">'+rows.join('')+'</div>';
      readoutEl.querySelectorAll('.copy').forEach(b=>b.addEventListener('click',()=>copyText(b.dataset.copy,b.dataset.label||'Copied')));

      const manualApply=q('.manualApply');
      if(manualApply) manualApply.addEventListener('click',()=>{
        const lat=parseFloat(q('.manualLat').value), lon=parseFloat(q('.manualLon').value);
        setInitialLocation(lat,lon,'manual entry',null);
      });
      const deviceBtn=q('.useDeviceLocation');
      if(deviceBtn) deviceBtn.addEventListener('click',()=>{
        if(!navigator.geolocation){ cstat('Device location is unavailable in this browser.','err'); return; }
        deviceBtn.disabled=true; cstat('Waiting for explicit device location…','loading');
        navigator.geolocation.getCurrentPosition(pos=>{
          deviceBtn.disabled=false;
          setInitialLocation(pos.coords.latitude,pos.coords.longitude,'current device location',pos.coords.accuracy);
        },error=>{ deviceBtn.disabled=false; cstat('Device location was not provided: '+error.message,'warn'); },
        {enableHighAccuracy:true,timeout:15000,maximumAge:0});
      });
      const applyCoords=q('.applyCoords');
      if(applyCoords) applyCoords.addEventListener('click',()=>{
        const lat=parseFloat(q('.editLat').value), lon=parseFloat(q('.editLon').value);
        applyAdjustedLocation(lat,lon);
      });
      const reset=q('.resetLocation'); if(reset) reset.addEventListener('click',resetLocation);
      const reason=q('.adjustmentReason'); if(reason) reason.addEventListener('input',()=>{ state.adjustmentReason=reason.value; });
      const cap=q('.captionField'); if(cap) cap.addEventListener('input',()=>{ state.caption=cap.value; state.captionEdited=true; });
      const hf=q('.headingField'); if(hf) hf.addEventListener('input',()=>{
        let v=parseInt(hf.value,10);
        if(isNaN(v)) state.heading=null; else{ v=((v%360)+360)%360; state.heading=v; }
        const hc=q('.headingCompass'); if(hc) hc.textContent=state.heading!=null?('° '+compass(state.heading)):'set direction';
        setCone(state.heading);
      });
      updateMapLinks();
    }

    function validCoordinates(lat,lon){ return Number.isFinite(lat)&&Number.isFinite(lon)&&lat>=-90&&lat<=90&&lon>=-180&&lon<=180; }
    function setInitialLocation(lat,lon,source,accuracy){
      if(!validCoordinates(lat,lon)){ cstat('Enter valid decimal latitude and longitude.','err'); return; }
      state.lat=lat; state.lon=lon; state.sourceLat=lat; state.sourceLon=lon;
      state.locationSource=source; state.accuracy=Number.isFinite(accuracy)?accuracy:null;
      state.pinMoved=false; state.adjustmentReason='';
      renderReadout(metadata); updateMapMode(); scheduleGeocode();
      buildBtn.disabled=false; buildPlainBtn.disabled=false;
      cstat('Location added from '+source+'.','ok');
    }
    function applyAdjustedLocation(lat,lon){
      if(!validCoordinates(lat,lon)){ cstat('Enter valid decimal latitude and longitude.','err'); return; }
      if(state.sourceLat==null){ setInitialLocation(lat,lon,'manual entry',null); return; }
      state.lat=lat; state.lon=lon;
      state.pinMoved=RT.haversineMeters(state.sourceLat,state.sourceLon,lat,lon)>.25;
      renderReadout(metadata); updateMapMode(); scheduleGeocode();
      cstat(state.pinMoved?'Coordinates adjusted. Add a reason before handoff.':'Coordinates match the original location.',state.pinMoved?'warn':'ok');
    }
    function resetLocation(){
      if(state.sourceLat==null) return;
      state.lat=state.sourceLat; state.lon=state.sourceLon; state.pinMoved=false; state.adjustmentReason='';
      renderReadout(metadata); updateMapMode(); scheduleGeocode(); gpsStatus();
    }
    function updateCoordReadout(){ renderReadout(metadata); }
    function updateMapLinks(){
      if(state.lat==null) return;
      const pair=state.lat+','+state.lon, encoded=encodeURIComponent(pair);
      const geo=q('.geoLink'); if(geo) geo.href=RT.navigationUrl(CONFIG,state);
      const gm=q('.gmapLink'); if(gm) gm.href='https://www.google.com/maps/search/?api=1&query='+encoded;
      const am=q('.amapLink'); if(am) am.href='https://maps.apple.com/?ll='+encoded+'&q='+encodeURIComponent(state.recordId);
      const os=q('.osmLink'); if(os) os.href='https://www.openstreetmap.org/?mlat='+state.lat+'&mlon='+state.lon+'#map=18/'+state.lat+'/'+state.lon;
    }

    /* ----- reverse geocoding (prefills caption unless user typed) ----- */
    async function reverseGeocode(lat,lon,signal){
      const cap=q('.captionField');
      if(!CONFIG.geocoder.enabled||!CONFIG.geocoder.url||networkMode!=='online') return;
      const ctrl=new AbortController();
      const abort=()=>ctrl.abort();
      if(signal) signal.addEventListener('abort',abort,{once:true});
      const timeout=setTimeout(()=>ctrl.abort(),7000);
      try{
        const url=new URL(CONFIG.geocoder.url,location.href);
        url.searchParams.set('format','jsonv2'); url.searchParams.set('lat',lat); url.searchParams.set('lon',lon); url.searchParams.set('zoom','18');
        const r=await fetch(url,
          {headers:{'Accept':'application/json'},signal:ctrl.signal});
        if(!r.ok) throw new Error('Address provider returned '+r.status);
        const j=await r.json();
        if(j && j.display_name){
          state.address=j.display_name;
          if(!state.captionEdited){
            state.caption=j.display_name;
            if(cap) cap.value=j.display_name;
          }
        }else if(cap && !state.captionEdited){ cap.placeholder='Address unavailable — type a caption'; }
      }catch(error){
        if(error&&error.name!=='AbortError'&&cap&&!state.captionEdited) cap.placeholder='Address lookup unavailable — type a caption';
      }finally{
        clearTimeout(timeout);
        if(signal) signal.removeEventListener('abort',abort);
      }
    }

    function scheduleGeocode(){
      if(geocodeController) geocodeController.abort();
      geocodeController=new AbortController();
      if(state.lat==null||networkMode!=='online'||!CONFIG.geocoder.enabled||!CONFIG.geocoder.url) return;
      const signal=geocodeController.signal, lat=state.lat, lon=state.lon;
      queueGeocode(()=>reverseGeocode(lat,lon,signal),signal);
    }

    /* ----- map ----- */
    function syncMapHeight(){
      if(!map) return;
      if(!isPhone()){ const h=photoImg.clientHeight; if(h) mapEl.style.height=h+'px'; }
      else mapEl.style.height='300px';
      map.invalidateSize();
    }

    function setCone(deg){
      if(!marker || !marker._icon) return;
      const holder=marker._icon.querySelector('.geo-cone-holder');
      if(!holder) return;
      if(deg==null || isNaN(deg)){ holder.style.display='none'; }
      else{ holder.style.display='block'; holder.style.transform='rotate('+deg+'deg)'; }
    }

    function popupHtml(lat,lon){
      lat=(lat!=null?lat:state.lat); lon=(lon!=null?lon:state.lon);
      const pair=RT.formatCoordinate(lat,state.accuracy)+', '+RT.formatCoordinate(lon,state.accuracy);
      const title=state.pinMoved ? '📍 Adjusted location' : '📍 Photo location';
      return '<strong>'+title+'</strong><br>'+pair+'<br><span>Drag or use the keyboard coordinate fields to adjust</span>';
    }

    function onPinMoved(){
      const p=marker.getLatLng();
      if(accCircle){ map.removeLayer(accCircle); accCircle=null; }
      state.lat=p.lat; state.lon=p.lng;
      state.pinMoved=RT.haversineMeters(state.sourceLat,state.sourceLon,state.lat,state.lon)>.25;
      updateCoordReadout();
      marker.setPopupContent(popupHtml());
      scheduleGeocode();
    }

    function destroyMap(){
      networkController.abort(); networkController=new AbortController();
      if(map){ map.remove(); map=null; marker=null; accCircle=null; }
      mapPending=false; zoomEl.textContent='—';
    }

    function renderLocalPanel(){
      destroyMap();
      const pair=state.lat==null?'Add coordinates to continue':RT.formatCoordinate(state.lat,state.accuracy)+', '+RT.formatCoordinate(state.lon,state.accuracy);
      mapEl.innerHTML='<div class="local-map-panel"><strong>Local coordinates mode</strong><span>'+esc(pair)+'</span><span class="provider-note">No automatic map or address request has been sent.</span></div>';
    }

    function renderMap(){
      if(mapPending||map||!mapVisible||networkMode!=='online'||state.lat==null) return Promise.resolve();
      mapPending=true;
      return new Promise(resolve=>{
        mapEl.innerHTML='';
        requestAnimationFrame(()=>{
          if(networkMode!=='online'||!card.isConnected){ mapPending=false; resolve(); return; }
          map=L.map(mapEl,{preferCanvas:false,zoomControl:true}).setView([state.lat,state.lon],16);
          syncMapHeight();
          tileLayerFor(currentMapType()).addTo(map);
          marker=L.marker([state.lat,state.lon],{icon:pinIcon,draggable:true,autoPan:true}).addTo(map);
          // GPS uncertainty ring; once the pin is hand-corrected the camera's
          // fix no longer describes the shown location, so it stays hidden.
          if(state.accuracy!=null && !state.pinMoved){
            accCircle=L.circle([state.lat,state.lon],{radius:state.accuracy,
              color:'#c54405',weight:1.5,opacity:.7,
              fillColor:'#ef5d12',fillOpacity:.12,interactive:false}).addTo(map);
          }
          marker.bindPopup(popupHtml()).openPopup();
          marker.on('drag',()=>{ const p=marker.getLatLng(); marker.setPopupContent(popupHtml(p.lat,p.lng)); });
          marker.on('dragend',onPinMoved);
          setCone(state.heading);
          L.control.scale({metric:true,imperial:true,position:'bottomright'}).addTo(map);
          map.on('zoomend',()=>{ zoomEl.textContent='z'+map.getZoom(); });
          zoomEl.textContent='z'+map.getZoom();
          setTimeout(()=>{ if(map) map.invalidateSize(); mapPending=false; resolve(); },180);
        });
      });
    }

    function updateMapMode(){
      if(state.lat==null||networkMode!=='online'){ renderLocalPanel(); return; }
      destroyMap();
      mapEl.innerHTML='<div class="local-map-panel"><strong>Online map enabled</strong><span>Map loads when this card is visible.</span></div>';
      renderMap().catch(error=>{ console.error('map',error); renderLocalPanel(); });
    }

    function restyleMap(){
      if(state.lat==null||networkMode!=='online') return;
      destroyMap(); renderMap().catch(error=>console.error('map style',error));
    }

    /* ----- export composite (one report per photo) ----- */
    async function buildExport(withCaption=true){
      if(state.lat==null) return null;
      if(state.pinMoved&&!state.adjustmentReason.trim()){
        cstat('Add an adjustment reason before exporting this corrected location.','err');
        return null;
      }
      cstat('Rendering report image…','loading');
      try{
        await loadQrLibrary();
        if(networkMode==='online') await loadMapCapture();
      }catch(error){
        cstat('Could not load the export components — check the connection and try again.','err');
        throw error;
      }

      const scale=2, gap=18, radius=14, maxW=1180, captureScale=2;
      const ar=(photoImg.naturalHeight/photoImg.naturalWidth)||1;
      const panelW=Math.max(360,Math.round(Math.min(photoImg.naturalWidth,(maxW-gap)/2)));
      const imgW=panelW, imgH=Math.round(panelW*ar), mapW=panelW, mapH=imgH;
      const W=imgW+mapW+gap, lineH=18;
      const capFont='12px "IBM Plex Mono", monospace';
      const smallFont='10px "IBM Plex Mono", monospace';
      const capLines=withCaption?wrapLines(state.caption,W,capFont,Infinity):[];
      const provider=networkMode==='online'?CONFIG.providers[currentMapType()]:null;
      const sourcePair=state.sourceLat==null?'not recorded':RT.formatCoordinate(state.sourceLat,state.accuracy)+', '+RT.formatCoordinate(state.sourceLon,state.accuracy);
      const currentPair=RT.formatCoordinate(state.lat,state.accuracy)+', '+RT.formatCoordinate(state.lon,state.accuracy);
      const displacement=state.pinMoved?RT.haversineMeters(state.sourceLat,state.sourceLon,state.lat,state.lon):0;
      const navigationUrl=RT.navigationUrl(CONFIG,state);
      const metaEntries=[
        'RECORD '+state.recordId+' · SOURCE '+state.sourceFilename,
        'CAPTURED '+(state.capturedAt||'not recorded')+' · TZ '+(state.timezone||'not recorded'),
        'ORIGINAL '+sourcePair+(state.pinMoved?' · ADJUSTED '+currentPair+' · '+Math.round(displacement)+' m':''),
        state.pinMoved?'ADJUSTMENT '+state.adjustmentReason:'LOCATION SOURCE '+state.locationSource,
        'ACCURACY '+(state.accuracy!=null?'±'+fmtAcc(state.accuracy)+' m':'not recorded; displayed precision limited'),
        'MAP '+(provider?provider.label:'none · local coordinates mode')+' · APP '+CONFIG.appVersion+' · BUILD '+CONFIG.buildId,
        'NAV '+navigationUrl
      ];
      const metaLines=metaEntries.flatMap(line=>wrapLines(line,W,smallFont,Infinity));
      const warnLines=(state.accuracy!=null&&state.accuracy>ACC_WARN_M?1:0)+(state.gpsStaleMin!=null&&state.gpsStaleMin>STALE_FIX_MIN?1:0);
      const footerH=18+24+capLines.length*lineH+warnLines*lineH+metaLines.length*15+178;
      const H=imgH+footerH;

      const canvas=exportCanvas, ctx=canvas.getContext('2d');
      canvas.width=W*scale; canvas.height=H*scale; canvas.style.width=W+'px'; canvas.style.height='';
      ctx.scale(scale,scale); ctx.fillStyle='#fbf9f4'; ctx.fillRect(0,0,W,H);
      const round=(x,y,w,h,r)=>{ctx.beginPath();ctx.moveTo(x+r,y);ctx.arcTo(x+w,y,x+w,y+h,r);ctx.arcTo(x+w,y+h,x,y+h,r);ctx.arcTo(x,y+h,x,y,r);ctx.arcTo(x,y,x+w,y,r);ctx.closePath();};

      try{
        await new Promise((resolve,reject)=>{
          const image=new Image();
          image.onload=()=>{ctx.save();round(0,0,imgW,imgH,radius);ctx.clip();ctx.drawImage(image,0,0,imgW,imgH);ctx.restore();resolve();};
          image.onerror=reject; image.src=displaySrc;
        });
      }catch(error){ cstat('Could not render the report image — the photo failed to load.','err'); throw error; }

      const mx=imgW+gap;
      let mapComplete=true;
      if(networkMode==='online'&&provider&&provider.enabled&&provider.url){
        const off=document.createElement('div');
        Object.assign(off.style,{width:mapW+'px',height:mapH+'px',position:'absolute',left:'-10000px',top:'0',overflow:'hidden'});
        document.body.appendChild(off);
        const cleanMap=L.map(off,{zoomControl:false,attributionControl:true,dragging:false,scrollWheelZoom:false,
          doubleClickZoom:false,boxZoom:false,keyboard:false,touchZoom:false,tap:false,fadeAnimation:false,zoomAnimation:false,inertia:false})
          .setView([state.lat,state.lon],map?map.getZoom():16);
        const tileLayer=tileLayerFor(currentMapType());
        let tileLoads=0,tileErrors=0,timedOut=false;
        tileLayer.on('tileload',()=>{tileLoads++;});
        tileLayer.on('tileerror',()=>{tileErrors++;});
        const tilesReady=new Promise(resolve=>{
          const timer=setTimeout(()=>{timedOut=true;resolve(false);},10000);
          tileLayer.once('load',()=>{clearTimeout(timer);resolve(true);});
        });
        tileLayer.addTo(cleanMap); cleanMap.invalidateSize(false);
        try{
          const loaded=await tilesReady;
          mapComplete=loaded&&!timedOut&&tileErrors===0&&tileLoads>0;
          await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
          const mapCanvas=await html2canvas(off,{useCORS:true,allowTaint:false,backgroundColor:'#e7e2d6',scale:captureScale,logging:false});
          ctx.save();round(mx,0,mapW,mapH,radius);ctx.clip();drawCover(ctx,mapCanvas,mx,0,mapW,mapH);
          const tipX=mx+mapW/2,tipY=mapH/2;
          if(state.heading!=null){
            const R=54,half=30*Math.PI/180,up=-Math.PI/2;
            ctx.save();ctx.translate(tipX,tipY);ctx.rotate(state.heading*Math.PI/180);ctx.beginPath();ctx.moveTo(0,0);
            ctx.arc(0,0,R,up-half,up+half);ctx.closePath();ctx.fillStyle='rgba(185,71,0,.30)';ctx.fill();ctx.lineWidth=2;ctx.strokeStyle='#7a2d00';ctx.stroke();ctx.restore();
          }
          const pin=new Image(); await new Promise(resolve=>{pin.onload=resolve;pin.onerror=resolve;pin.src='data:image/svg+xml,'+PIN_SVG;});
          ctx.drawImage(pin,tipX-17,tipY-44,34,44);
          drawProviderAttribution(ctx,currentMapType(),mx,mapH,mapW);
          if(!mapComplete){
            const warning='⚠ MAP TILES INCOMPLETE';ctx.font='600 10px "IBM Plex Mono", monospace';const ww=ctx.measureText(warning).width;
            ctx.fillStyle='rgba(255,255,255,.9)';ctx.fillRect(mx+8,8,ww+12,20);ctx.fillStyle='#7a2d00';ctx.fillText(warning,mx+14,22);
          }
          ctx.restore();
        }catch(error){
          console.error('map capture',error);mapComplete=false;ctx.save();round(mx,0,mapW,mapH,radius);ctx.clip();
          ctx.fillStyle='#e7e2d6';ctx.fillRect(mx,0,mapW,mapH);ctx.fillStyle='#45484d';ctx.font='13px monospace';ctx.textAlign='center';
          ctx.fillText('map unavailable',mx+mapW/2,mapH/2);ctx.restore();
          drawProviderAttribution(ctx,currentMapType(),mx,mapH,mapW);
        }finally{ cleanMap.remove();off.remove(); }
      }else{
        ctx.save();round(mx,0,mapW,mapH,radius);ctx.clip();ctx.fillStyle='#e7e2d6';ctx.fillRect(mx,0,mapW,mapH);
        ctx.textAlign='center';ctx.fillStyle='#1a1c1e';ctx.font='600 15px "IBM Plex Mono", monospace';ctx.fillText('LOCAL COORDINATES',mx+mapW/2,mapH*.34);
        ctx.font='600 20px "IBM Plex Mono", monospace';ctx.fillText(RT.formatCoordinate(state.lat,state.accuracy)+'°',mx+mapW/2,mapH*.48);
        ctx.fillText(RT.formatCoordinate(state.lon,state.accuracy)+'°',mx+mapW/2,mapH*.58);
        ctx.font='11px "IBM Plex Mono", monospace';ctx.fillStyle='#45484d';ctx.fillText('No automatic map/address request sent',mx+mapW/2,mapH*.72);ctx.restore();
      }

      let y=imgH+16;ctx.textAlign='left';ctx.fillStyle='#b94700';ctx.fillRect(0,y,52,3);y+=22;
      ctx.fillStyle='#1a1c1e';ctx.font='600 13px "IBM Plex Mono", monospace';
      const coord='LAT '+RT.formatCoordinate(state.lat,state.accuracy)+'°   LON '+RT.formatCoordinate(state.lon,state.accuracy)+'°'+
        (state.heading!=null?'   HDG '+Math.round(state.heading)+'° '+compass(state.heading):'');
      ctx.fillText(coord,0,y);
      if(withCaption&&capLines.length){ctx.fillStyle='#45484d';ctx.font=capFont;for(const line of capLines){y+=lineH;ctx.fillText(line,0,y);}}
      if(state.accuracy!=null&&state.accuracy>ACC_WARN_M){y+=lineH;ctx.fillStyle='#7a2d00';ctx.font='600 11px "IBM Plex Mono", monospace';ctx.fillText('⚠ LOW GPS ACCURACY (±'+fmtAcc(state.accuracy)+' M) — VERIFY LOCATION',0,y);}
      if(state.gpsStaleMin!=null&&state.gpsStaleMin>STALE_FIX_MIN){y+=lineH;ctx.fillStyle='#7a2d00';ctx.font='600 11px "IBM Plex Mono", monospace';ctx.fillText('⚠ GPS FIX ~'+Math.round(state.gpsStaleMin)+' MIN OLDER THAN PHOTO',0,y);}
      y+=17;ctx.fillStyle='#45484d';ctx.font=smallFont;for(const line of metaLines){ctx.fillText(line,0,y);y+=15;}
      drawNavigationQr(ctx,navigationUrl,W-8,H-28,128);

      const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
      state.mapComplete=mapComplete;
      if(!mapComplete)cstat('Report built, but map tiles are incomplete — review the marked panel.','warn');else gpsStatus();
      return blob;
    }

    function filename(suffix){
      return 'geotag_'+state.recordId+(suffix||'')+'.png';
    }
    function getRecord(){
      const provider=networkMode==='online'?CONFIG.providers[currentMapType()]:null;
      const displacement=state.pinMoved&&state.sourceLat!=null
        ?RT.haversineMeters(state.sourceLat,state.sourceLon,state.lat,state.lon):0;
      const record={
        recordId:state.recordId,sourceFilename:state.sourceFilename,capturedAt:state.capturedAt,timezone:state.timezone,
        latitude:state.lat,longitude:state.lon,originalLatitude:state.sourceLat,originalLongitude:state.sourceLon,
        accuracyMeters:state.accuracy,displacementMeters:Math.round(displacement*10)/10,
        adjustmentReason:state.adjustmentReason,caption:state.caption,mapProvider:provider?provider.label:'Local coordinates',
        appVersion:CONFIG.appVersion
      };
      record.navigationUrl=RT.navigationUrl(CONFIG,{recordId:record.recordId,lat:record.latitude,lon:record.longitude});
      return record;
    }
    function shareText(){
      return RT.shareText(CONFIG,{recordId:state.recordId,lat:state.lat,lon:state.lon,accuracy:state.accuracy});
    }

    /* ----- editor integration: swap the display image, never the file ----- */
    const retiredSrcs=[];   // superseded edit URLs; an in-flight export may still
                            // read them, so they are revoked on card removal
    async function applyEdit(blob){
      const url=URL.createObjectURL(blob);
      try{
        await new Promise((res,rej)=>{ photoImg.onload=res; photoImg.onerror=rej; photoImg.src=url; });
      }catch(e){ URL.revokeObjectURL(url); throw e; }
      if(displaySrc && displaySrc!==originalSrc) retiredSrcs.push(displaySrc);
      displaySrc=url;
      editedTag.style.display='inline-block';
      dimEl.textContent=photoImg.naturalWidth+' × '+photoImg.naturalHeight+' px';
      syncMapHeight();
      ping('Photo updated ✓');
    }
    async function revertOriginal(){
      if(displaySrc===originalSrc) return;
      await new Promise((res,rej)=>{ photoImg.onload=res; photoImg.onerror=rej; photoImg.src=originalSrc; });
      if(displaySrc && displaySrc!==originalSrc) retiredSrcs.push(displaySrc);
      displaySrc=originalSrc;
      editedTag.style.display='none';
      dimEl.textContent=photoImg.naturalWidth+' × '+photoImg.naturalHeight+' px';
      syncMapHeight();
      ping('Original photo restored ✓');
    }

    function remove(){
      if(ro) ro.disconnect();
      if(mapObserver) mapObserver.disconnect();
      lifetimeController.abort(); networkController.abort(); geocodeController.abort();
      destroyMap();
      if(displaySrc && displaySrc!==originalSrc) URL.revokeObjectURL(displaySrc);
      if(originalSrc) URL.revokeObjectURL(originalSrc);
      retiredSrcs.splice(0).forEach(u=>URL.revokeObjectURL(u));
      displaySrc=null; originalSrc=null;
      if(currentRecordId===state.recordId){ currentBlob=null; currentName='geotag.png'; currentShareText=''; currentRecordId=null; if(overlay.open) overlay.close(); }
      card.remove();
      const i=photos.indexOf(inst); if(i>=0) photos.splice(i,1);
      updateCount();
      if(!photos.length) workspace.classList.remove('show');
    }

    if('ResizeObserver' in window){
      ro=new ResizeObserver(()=>{ if(map && !isPhone()) syncMapHeight(); });
      ro.observe(photoImg);
    }

    if('IntersectionObserver' in window){
      mapObserver=new IntersectionObserver(entries=>{
        mapVisible=entries.some(entry=>entry.isIntersecting);
        if(mapVisible&&networkMode==='online') renderMap().catch(error=>console.error('lazy map',error));
      },{rootMargin:'240px'});
      mapObserver.observe(mapPane);
    }

    const inst={ buildBtn, buildPlainBtn, buildExport, filename, restyleMap, syncMapHeight, remove,
                 applyEdit, revertOriginal, hasGps:()=>state.lat!=null,hasLocation:()=>state.lat!=null,
                 getRecord,shareText,setNetworkMode:()=>{updateMapMode();scheduleGeocode();renderReadout(metadata);},
                 cancelNetwork:()=>{networkController.abort();geocodeController.abort();destroyMap();},
                 getDisplaySrc:()=>displaySrc, getOriginalSrc:()=>originalSrc };
    buildBtn.addEventListener('click',()=>openExport(inst,buildBtn,true));
    buildPlainBtn.addEventListener('click',()=>openExport(inst,buildPlainBtn,false));
    editBtn.addEventListener('click',()=>editor.open(inst));
    removeBtn.addEventListener('click',remove);
    photos.push(inst);
    updateCount();
    queuePhotoTask(load,lifetimeController.signal).catch(error=>{ if(error&&error.name!=='AbortError') console.error('processing queue',error); });
    return inst;
  }

  /* ---------- intake ---------- */
  function addFiles(list){
    const files=Array.from(list||[]);
    const available=Math.max(0,CONFIG.maxFiles-photos.length);
    const valid=files.filter(validImage);
    const sized=valid.filter(file=>file.size<=CONFIG.maxFileBytes);
    const good=sized.slice(0,available);
    if(!good.length){ setStatus('Please choose JPG, PNG or HEIC files.','err'); return; }
    if(good.length<files.length){
      const reasons=[];
      if(valid.length<files.length) reasons.push('unsupported type');
      if(sized.length<valid.length) reasons.push('over '+Math.round(CONFIG.maxFileBytes/1024/1024)+' MB');
      if(good.length<sized.length) reasons.push('batch limit '+CONFIG.maxFiles);
      setStatus('Some files were skipped: '+reasons.join(', ')+'.','warn');
    }
    else clearStatus();
    // On the first clean batch, hand focus of the page over to the new cards;
    // skip when files were rejected so the warning above stays readable.
    const followToWorkspace=!photos.length && good.length===files.length;
    workspace.classList.add('show');
    good.forEach(createPhoto);
    if(followToWorkspace) requestAnimationFrame(()=>workspace.scrollIntoView({
      behavior:window.matchMedia('(prefers-reduced-motion:reduce)').matches?'auto':'smooth',
      block:'start'
    }));
  }

  /* ---------- events ---------- */
  function pick(){ fileInput.click(); }
  function takePhoto(){ cameraInput.click(); }
  dropzone.addEventListener('click',pick);
  dropzone.addEventListener('keydown',e=>{ if(e.key==='Enter'||e.key===' '){e.preventDefault();pick();} });
  dropzone.querySelector('.browse').addEventListener('click',e=>{e.stopPropagation();pick();});
  $('cameraBtn').addEventListener('click',e=>{e.stopPropagation();takePhoto();});
  dropzone.addEventListener('dragover',e=>{e.preventDefault();dropzone.classList.add('over');});
  dropzone.addEventListener('dragleave',()=>dropzone.classList.remove('over'));
  dropzone.addEventListener('drop',e=>{
    e.preventDefault();dropzone.classList.remove('over');
    addFiles(e.dataTransfer.files);
  });
  fileInput.addEventListener('change',e=>{ addFiles(e.target.files); fileInput.value=''; });
  cameraInput.addEventListener('change',e=>{ addFiles(e.target.files); cameraInput.value=''; });

  (async function receiveShareTarget(){
    const token=new URLSearchParams(location.search).get('share-target');
    if(!token) return;
    try{
      const path='shared/'+encodeURIComponent(token), response=await fetch(path);
      if(!response.ok) throw new Error('Shared photo expired');
      const blob=await response.blob();
      const name=decodeURIComponent(response.headers.get('X-GeoTag-Filename')||'shared-photo.jpg');
      addFiles([new File([blob],name,{type:blob.type||'image/jpeg'})]);
      if('caches' in window){const cache=await caches.open('geotag-share-v1');await cache.delete(path);}
      history.replaceState(null,'',location.pathname);
    }catch(error){ setStatus('Could not import the shared photo: '+error.message,'err'); }
  })();

  document.querySelectorAll('input[name="privacyMode"]').forEach(input=>input.addEventListener('change',()=>{
    if(input.value==='local'){ setPrivacyMode('local'); return; }
    input.checked=false;
    if(!$('privacyDialog').open) $('privacyDialog').showModal();
  }));
  $('privacyDialog').addEventListener('close',()=>{
    setPrivacyMode($('privacyDialog').returnValue==='confirm'?'online':'local');
  });

  async function clearOwnedPrivateCaches(includeSharedPhotos=false){
    let removed=0;
    if('caches' in window){
      const keys=await caches.keys();
      for(const key of keys.filter(name=>name.startsWith('geotag-')&&(/(tile|map)/i.test(name)||(includeSharedPhotos&&name==='geotag-share-v1')))){
        if(await caches.delete(key)) removed++;
      }
    }
    if(navigator.serviceWorker&&navigator.serviceWorker.controller)
      navigator.serviceWorker.controller.postMessage({type:includeSharedPhotos?'CLEAR_PRIVATE_DATA':'CLEAR_MAP_DATA'});
    return removed;
  }

  $('clearMapDataBtn').addEventListener('click',async()=>{
    const removed=await clearOwnedPrivateCaches(false);
    ping(removed?'Offline map data cleared':'No GeoTag offline map data stored');
  });

  $('clearAllBtn').addEventListener('click',async()=>{
    photos.slice().forEach(p=>p.remove());
    processingQueue.cancelPending('Cleared'); geocodeQueue.cancelPending('Cleared');
    currentBlob=null; currentName='geotag.png'; currentShareText=''; currentRecordId=null;
    $('shareDetails').value=''; if(overlay.open) overlay.close();
    await clearOwnedPrivateCaches(true);
    clearStatus();
    window.scrollTo({top:0,behavior:window.matchMedia('(prefers-reduced-motion:reduce)').matches?'auto':'smooth'});
  });

  /* ---------- export every report into one Word document ----------
     Reports are rendered sequentially because buildExport() draws onto the
     shared #exportCanvas; all build buttons are disabled meanwhile so a user
     can't race the canvas or mutate the photo list mid-batch. */
  const exportDocxBtn=$('exportDocxBtn'), exportDocxPlainBtn=$('exportDocxPlainBtn');
  const exportMenu=document.querySelector('.export-menu'),
        exportMenuSummary=exportMenu.querySelector('summary'),
        exportMenuLabel=exportMenuSummary.textContent;
  // Menu items keep reporting progress after the menu closes by mirroring
  // their label onto the always-visible summary button.
  function mirrorMenuProgress(triggerBtn,text){
    if(!exportMenu.contains(triggerBtn)) return;
    exportMenuSummary.textContent=text==null?exportMenuLabel:text;
  }
  async function exportAllDocx(triggerBtn,withCaption){
    if(!photos.length) return;
    if(exportBusy){ ping('Another export is still running'); return; }
    exportBusy=true;

    const label=triggerBtn.innerHTML;
    const batch=photos.slice();
    exportDocxBtn.disabled=true; exportDocxPlainBtn.disabled=true;
    $('clearAllBtn').disabled=true;
    batch.forEach(p=>{ p.buildBtn.disabled=true; p.buildPlainBtn.disabled=true; });

    const IMG_W=600; // px @96dpi ≈ 6.25in — fits US Letter inside 1in margins + cell padding
    const children=[]; let skipped=0, failed=0;

    try{
      try{
        triggerBtn.textContent='Preparing Word export…';
        mirrorMenuProgress(triggerBtn,'Preparing Word export…');
        await loadDocxLibrary();
      }catch(error){
        console.error('word export',error);
        ping('Word export unavailable — the library failed to load');
        return;
      }
      for(let i=0;i<batch.length;i++){
        triggerBtn.textContent='Rendering '+(i+1)+'/'+batch.length+'…';
        mirrorMenuProgress(triggerBtn,'Rendering '+(i+1)+'/'+batch.length+'…');
        let blob=null;
        try{ blob=await batch[i].buildExport(withCaption); }
        catch(e){ console.error('word export: photo '+(i+1),e); failed++; continue; }
        if(!blob){ skipped++; continue; } // no GPS
        // read dimensions now — the canvas is reused by the next iteration
        const w=exportCanvas.width, h=exportCanvas.height;
        const data=await blob.arrayBuffer();
        // one single-cell table per picture; the empty paragraph after it keeps
        // adjacent tables from merging when Word opens the file
        children.push(new docx.Table({
          width:{size:100,type:docx.WidthType.PERCENTAGE},
          rows:[new docx.TableRow({children:[new docx.TableCell({
            margins:{top:120,bottom:120,left:120,right:120},
            children:[new docx.Paragraph({children:[new docx.ImageRun({
              type:'png', data,
              transformation:{width:IMG_W,height:Math.round(IMG_W*h/w)}
            })]})]
          })]})]
        }), new docx.Paragraph({}));
      }

      if(!children.length){
        ping(failed?'Export failed — no reports could be built':'No photos with GPS — nothing to export');
        return;
      }

      triggerBtn.textContent='Building document…';
      mirrorMenuProgress(triggerBtn,'Building document…');
      const doc=new docx.Document({sections:[{children}]});
      const out=await docx.Packer.toBlob(doc);

      const a=document.createElement('a');
      a.href=URL.createObjectURL(out);
      a.download='geotag_reports_'+new Date().toISOString().slice(0,10)+(withCaption?'':'_nocaption')+'.docx';
      a.click();
      setTimeout(()=>URL.revokeObjectURL(a.href),2000);

      ping('Word file downloaded ✓'+
        (skipped?' · '+skipped+' without GPS skipped':'')+
        (failed?' · '+failed+' failed':''));
    }catch(e){
      console.error('word export',e);
      ping('Word export failed');
    }finally{
      exportBusy=false;
      exportDocxBtn.disabled=false; exportDocxPlainBtn.disabled=false;
      triggerBtn.innerHTML=label;
      mirrorMenuProgress(triggerBtn,null);
      $('clearAllBtn').disabled=false;
      // recompute from current state — a photo may have finished loading (or
      // been found GPS-less) while the batch ran, so a snapshot would be stale
      batch.forEach(p=>{
        const ok=p.hasGps();
        p.buildBtn.disabled=!ok; p.buildPlainBtn.disabled=!ok;
      });
    }
  }
  exportDocxBtn.addEventListener('click',()=>exportAllDocx(exportDocxBtn,true));
  exportDocxPlainBtn.addEventListener('click',()=>exportAllDocx(exportDocxPlainBtn,false));

  function exportRecords(kind){
    const records=photos.filter(photo=>photo.hasLocation()).map(photo=>photo.getRecord());
    if(!records.length){ping('No located records to export');return;}
    const date=new Date().toISOString().slice(0,10);
    if(kind==='csv') RT.downloadBlob(new Blob([RT.recordsToCsv(records)],{type:'text/csv;charset=utf-8'}),'geotag_records_'+date+'.csv');
    if(kind==='json') RT.downloadBlob(new Blob([JSON.stringify(records,null,2)+'\n'],{type:'application/json'}),'geotag_records_'+date+'.json');
    if(kind==='geojson') RT.downloadBlob(new Blob([JSON.stringify(RT.recordsToGeoJson(records),null,2)+'\n'],{type:'application/geo+json'}),'geotag_records_'+date+'.geojson');
    ping(kind.toUpperCase()+' downloaded ✓');
  }

  async function exportReportBundle(kind,triggerBtn){
    if(exportBusy){ping('Another export is still running');return;}
    const batch=photos.filter(photo=>photo.hasLocation());
    if(!batch.length){ping('No located records to export');return;}
    exportBusy=true;const label=triggerBtn.textContent;triggerBtn.disabled=true;
    const entries=[],pages=[];
    try{
      for(let index=0;index<batch.length;index++){
        triggerBtn.textContent='Rendering '+(index+1)+'/'+batch.length+'…';
        mirrorMenuProgress(triggerBtn,'Rendering '+(index+1)+'/'+batch.length+'…');
        const blob=await batch[index].buildExport(true);if(!blob)continue;
        if(kind==='zip') entries.push({name:'reports/'+batch[index].filename(''),data:blob});
        else{
          const jpeg=await new Promise(resolve=>exportCanvas.toBlob(resolve,'image/jpeg',.92));
          pages.push({bytes:new Uint8Array(await jpeg.arrayBuffer()),width:exportCanvas.width,height:exportCanvas.height});
        }
      }
      const records=batch.map(photo=>photo.getRecord()),date=new Date().toISOString().slice(0,10);
      if(kind==='zip'){
        entries.push({name:'records.csv',data:new Blob([RT.recordsToCsv(records)])});
        entries.push({name:'records.json',data:new Blob([JSON.stringify(records,null,2)+'\n'])});
        entries.push({name:'records.geojson',data:new Blob([JSON.stringify(RT.recordsToGeoJson(records),null,2)+'\n'])});
        RT.downloadBlob(await RT.createZip(entries),'geotag_handoff_'+date+'.zip');
      }else RT.downloadBlob(await RT.createPdf(pages),'geotag_handoff_'+date+'.pdf');
      ping((kind==='zip'?'ZIP':'PDF')+' downloaded ✓');
    }catch(error){console.error(kind+' export',error);ping((kind==='zip'?'ZIP':'PDF')+' export failed');}
    finally{exportBusy=false;triggerBtn.disabled=false;triggerBtn.textContent=label;mirrorMenuProgress(triggerBtn,null);}
  }

  $('exportZipBtn').addEventListener('click',event=>exportReportBundle('zip',event.currentTarget));
  $('exportPdfBtn').addEventListener('click',event=>exportReportBundle('pdf',event.currentTarget));
  $('exportCsvBtn').addEventListener('click',()=>exportRecords('csv'));
  $('exportJsonBtn').addEventListener('click',()=>exportRecords('json'));
  $('exportGeoJsonBtn').addEventListener('click',()=>exportRecords('geojson'));

  // The export menu behaves like a real menu: choosing an item closes it, and
  // clicking elsewhere or pressing Escape dismisses it.
  exportMenu.querySelectorAll('.export-menu-items button').forEach(button=>{
    button.addEventListener('click',()=>{ exportMenu.open=false; });
  });
  document.addEventListener('click',event=>{
    if(exportMenu.open&&!exportMenu.contains(event.target)) exportMenu.open=false;
  });
  exportMenu.addEventListener('keydown',event=>{
    if(event.key==='Escape'&&exportMenu.open){ exportMenu.open=false; exportMenuSummary.focus(); }
  });

  // map style applies to every photo at once
  document.querySelectorAll('input[name="mapType"]').forEach(r=>{
    r.addEventListener('change',()=>{
      document.querySelectorAll('#mapTypes label').forEach(l=>l.classList.remove('active'));
      r.closest('label').classList.add('active');
      updatePrivacyControls();
      photos.forEach(p=>p.restyleMap());
    });
  });

  window.addEventListener('resize',()=>{ photos.forEach(p=>p.syncMapHeight()); editor.refit(); });

  function closeReport(){if(overlay.open)overlay.close();}
  $('closeModal').addEventListener('click',closeReport);
  overlay.addEventListener('click',e=>{if(e.target===overlay)closeReport();});
  overlay.addEventListener('close',()=>{
    if(reportLastFocus&&document.contains(reportLastFocus))reportLastFocus.focus();
    reportLastFocus=null;
  });

  $('downloadImgBtn').addEventListener('click',()=>{
    if(!currentBlob) return;
    RT.downloadBlob(currentBlob,currentName);
    ping('Downloaded ✓');
  });
  $('copyImgBtn').addEventListener('click',async()=>{
    if(!currentBlob) return;
    try{ await navigator.clipboard.write([new ClipboardItem({'image/png':currentBlob})]); ping('Image copied ✓'); }
    catch(_){ ping('Copy not supported — use Download'); }
  });
  $('copyDetailsBtn').addEventListener('click',()=>copyText(currentShareText,'Recipient details copied'));
  $('shareImgBtn').addEventListener('click',async()=>{
    if(!currentBlob) return;
    const file=new File([currentBlob],currentName,{type:'image/png'});
    try{ await navigator.share({files:[file],title:'GeoTag inspection',text:currentShareText}); }
    catch(_){}
  });
})();
