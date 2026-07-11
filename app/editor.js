(function(root){
  "use strict";

  root.createGeoTagEditor=function({$,ping,isPhone}){
    const overlayE=$('editorOverlay'), stage=$('edStage'),
          canvas=$('editorCanvas'), dctx=canvas.getContext('2d');
    const dial=$('edDial'), dialCtx=dial.getContext('2d'),
          dialVal=$('edDialVal'), dialWrap=$('edDialWrap');
    const topCrop=$('edTopCrop'), topMarkup=$('edTopMarkup'),
          aspectsRow=$('edAspects'), toolsRow=$('edTools');
    const undoBtn=$('edUndo'), applyBtn=$('edApply'), resetBtn=$('edReset');
    const modeCropBtn=$('edModeCrop'), modeMarkupBtn=$('edModeMarkup');

    const MAX_EDGE=2600, UNDO_MAX=15, DEG=Math.PI/180, PPD=6; // dial px per degree
    const COLORS=['#e02121','#ef5d12','#f7b500','#16a34a','#2563eb','#17191c','#ffffff'];
    const WIDTHS={s:0.0009,m:0.0017,l:0.0034};   // stroke as a fraction of the long edge
    const WIDTH_MIN={s:1.5,m:2.5,l:5};
    const FONT_PCT={s:0.016,m:0.025,l:0.04};     // text size as a fraction of the long edge

    let inst=null, work=null, wctx=null;
    let mode='crop', tool='pen', color=COLORS[0], widthKey='m';
    // crop-session state
    let thetaDeg=0, crop=null, cropBase=null, sesRot=false, sesFlip=false;
    let vDeg=0, hDeg=0, adjKey='straighten';  // perspective tilts + active dial control
    let ratio=0, sesOrigRatio=1;              // 0 = freeform
    let view={s:1,ax:0,ay:0}, dpr=1;          // screen = A + r·s  (r in rotated space)
    let drag=null, shape=null, dialDrag=null, anim=null, textBox=null;
    const pointers=new Map();
    let undoStack=[], dirtyFloor=false, restoredPristine=false;
    // Async safety: `session` invalidates continuations of a closed/reopened
    // editor; `busy` serializes bitmap mutations against pending awaits.
    let session=0, busy=false, lastFocus=null;

    /* ----- small helpers ----- */
    function loadImage(src){
      return new Promise((res,rej)=>{ const i=new Image(); i.onload=()=>res(i); i.onerror=rej; i.src=src; });
    }
    function canvasFrom(img){
      const sc=Math.min(1,MAX_EDGE/Math.max(img.naturalWidth,img.naturalHeight));
      const c=document.createElement('canvas');
      c.width=Math.max(1,Math.round(img.naturalWidth*sc));
      c.height=Math.max(1,Math.round(img.naturalHeight*sc));
      c.getContext('2d').drawImage(img,0,0,c.width,c.height);
      return c;
    }
    function setWorkBitmap(c){ work=c; wctx=c.getContext('2d'); }
    const theta=()=>thetaDeg*DEG;
    const imgC=()=>({x:work.width/2,y:work.height/2});
    function rotP(p,c,ang){
      const cos=Math.cos(ang),sin=Math.sin(ang),dx=p.x-c.x,dy=p.y-c.y;
      return {x:c.x+dx*cos-dy*sin, y:c.y+dx*sin+dy*cos};
    }
    // Perspective model: the photo plane tilted about its horizontal axis
    // (vertical correction, vDeg) then its vertical axis (horizontal, hDeg),
    // seen by a camera at distance d — i.e. an exact keystone homography.
    // View space = that projection rotated by the straighten angle. All the
    // crop/clamp machinery only needs the forward map and its inverse.
    function perspCoef(){
      const f=vDeg*DEG, p=hDeg*DEG;
      const sinF=Math.sin(f), cosF=Math.cos(f), sinP=Math.sin(p), cosP=Math.cos(p);
      return {a1:cosP, b1:sinF*sinP, b2:cosF, a3:-sinP, b3:sinF*cosP,
              d:1.2*Math.max(work.width,work.height)};
    }
    function imgToView3(pt){ // image px → view px + homogeneous denominator
      const c=imgC(), k=perspCoef();
      const x=pt.x-c.x, y=pt.y-c.y;
      const x2=k.a1*x+k.b1*y, y2=k.b2*y, z2=k.a3*x+k.b3*y;
      const wc=(k.d-z2)/k.d;                       // >0 for our tilt range
      const r=rotP({x:x2/wc,y:y2/wc},{x:0,y:0},theta());
      return {x:r.x+c.x, y:r.y+c.y, w:wc};
    }
    const imgToView=pt=>{ const r=imgToView3(pt); return {x:r.x,y:r.y}; };
    function toImagePt(v){ // view px → image px (exact inverse; linear solve)
      const c=imgC(), k=perspCoef();
      const u=rotP({x:v.x-c.x,y:v.y-c.y},{x:0,y:0},-theta());
      const A=k.d*k.a1+u.x*k.a3, B=k.d*k.b1+u.x*k.b3;
      const C=u.y*k.a3,          E=k.d*k.b2+u.y*k.b3;
      const det=A*E-B*C;
      if(Math.abs(det)<1e-9) return {x:1e9,y:1e9};
      return {x:k.d*(u.x*E-B*u.y)/det+c.x, y:k.d*(A*u.y-u.x*C)/det+c.y};
    }
    const fullCrop=()=>({x:0,y:0,w:work.width,h:work.height});
    function validRect(r){
      const W=work.width,H=work.height;
      const pts=[{x:r.x,y:r.y},{x:r.x+r.w,y:r.y},{x:r.x+r.w,y:r.y+r.h},{x:r.x,y:r.y+r.h}];
      return pts.every(p=>{ const q=toImagePt(p);
        return q.x>=-0.6&&q.y>=-0.6&&q.x<=W+0.6&&q.y<=H+0.6; });
    }
    const lerpN=(a,b,t)=>a+(b-a)*t;
    const lerpRect=(a,b,t)=>({x:lerpN(a.x,b.x,t),y:lerpN(a.y,b.y,t),w:lerpN(a.w,b.w,t),h:lerpN(a.h,b.h,t)});
    // Largest valid rect between a known-good rect and a desired one.
    function clampRect(from,to){
      if(validRect(to)) return to;
      let lo=0,hi=1;
      for(let i=0;i<22;i++){ const m=(lo+hi)/2; if(validRect(lerpRect(from,to,m))) lo=m; else hi=m; }
      return lerpRect(from,to,lo);
    }
    // Shrink a rect about its own centre until it fits inside the image.
    function shrinkValid(cand){
      if(validRect(cand)) return cand;
      const c={x:cand.x+cand.w/2,y:cand.y+cand.h/2};
      let lo=0,hi=1;
      for(let i=0;i<22;i++){
        const m=(lo+hi)/2;
        const r={x:c.x-cand.w*m/2,y:c.y-cand.h*m/2,w:cand.w*m,h:cand.h*m};
        if(validRect(r)) lo=m; else hi=m;
      }
      return {x:c.x-cand.w*lo/2,y:c.y-cand.h*lo/2,w:Math.max(1,cand.w*lo),h:Math.max(1,cand.h*lo)};
    }
    const minCrop=()=>Math.max(16,Math.min(work.width,work.height)/40);
    function cropChanged(){
      const f=fullCrop();
      return Math.abs(crop.x-f.x)>0.5||Math.abs(crop.y-f.y)>0.5||
             Math.abs(crop.w-f.w)>0.5||Math.abs(crop.h-f.h)>0.5;
    }
    const sessionChanged=()=>thetaDeg!==0||vDeg!==0||hDeg!==0||sesRot||sesFlip||cropChanged();
    function isDirty(){
      return undoStack.length>0||dirtyFloor||sessionChanged()||
             !!(textBox&&textBox.box.innerText.trim());
    }

    /* ----- view (screen = A + r·s) ----- */
    function stageSize(){ return {w:stage.clientWidth||1,h:stage.clientHeight||1}; }
    function sizeCanvas(){
      dpr=Math.min(window.devicePixelRatio||1,2);
      const s=stageSize();
      canvas.width=Math.max(1,Math.round(s.w*dpr));
      canvas.height=Math.max(1,Math.round(s.h*dpr));
    }
    function targetView(){
      const s=stageSize(), pad=16;
      const sc=Math.max(0.001,Math.min((s.w-pad*2)/crop.w,(s.h-pad*2)/crop.h));
      return {s:sc, ax:(s.w-crop.w*sc)/2-crop.x*sc, ay:(s.h-crop.h*sc)/2-crop.y*sc};
    }
    const toRot=p=>({x:(p.x-view.ax)/view.s,y:(p.y-view.ay)/view.s});
    const toScreen=r=>({x:view.ax+r.x*view.s,y:view.ay+r.y*view.s});
    function stopAnim(){ if(anim){ cancelAnimationFrame(anim.raf); anim=null; } }
    function animateView(ms){
      stopAnim();
      const from={...view}, to=targetView(), t0=performance.now();
      const a={};
      a.raf=requestAnimationFrame(function step(now){
        if(anim!==a) return;
        const t=Math.min(1,(now-t0)/ms), e=1-Math.pow(1-t,3);
        view={s:lerpN(from.s,to.s,e),ax:lerpN(from.ax,to.ax,e),ay:lerpN(from.ay,to.ay,e)};
        render();
        if(t<1) a.raf=requestAnimationFrame(step); else anim=null;
      });
      anim=a;
    }

    /* ----- render ----- */
    function render(){
      if(!work) return;
      const s=stageSize();
      dctx.setTransform(1,0,0,1,0,0);
      dctx.clearRect(0,0,canvas.width,canvas.height);
      dctx.setTransform(dpr*view.s,0,0,dpr*view.s,dpr*view.ax,dpr*view.ay);
      if(mode==='crop'&&gl){
        renderGL();          // image on the GL canvas beneath; 2D draws the UI
      }else{
        const c=imgC();
        dctx.save();
        dctx.translate(c.x,c.y); dctx.rotate(theta()); dctx.translate(-c.x,-c.y);
        dctx.drawImage(work,0,0);
        dctx.restore();
      }
      if(mode==='crop') drawCropUI(s);
      else if(shape){
        // preview clipped to the photo, matching what baking will keep
        dctx.save();
        dctx.beginPath(); dctx.rect(0,0,work.width,work.height); dctx.clip();
        drawShape(dctx,shape);
        dctx.restore();
      }
    }
    function drawCropUI(s){
      const r=crop, lw=n=>n/view.s;
      const r0=toRot({x:0,y:0}), r1=toRot({x:s.w,y:s.h});
      dctx.fillStyle='rgba(6,6,8,.62)';
      dctx.fillRect(r0.x,r0.y,r1.x-r0.x,r.y-r0.y);
      dctx.fillRect(r0.x,r.y+r.h,r1.x-r0.x,r1.y-(r.y+r.h));
      dctx.fillRect(r0.x,r.y,r.x-r0.x,r.h);
      dctx.fillRect(r.x+r.w,r.y,r1.x-(r.x+r.w),r.h);
      // grid (denser while the straighten dial is active, like iOS)
      const n=dialDrag?9:3;
      dctx.strokeStyle='rgba(255,255,255,.3)';
      dctx.lineWidth=lw(1);
      dctx.beginPath();
      for(let i=1;i<n;i++){
        dctx.moveTo(r.x+r.w*i/n,r.y); dctx.lineTo(r.x+r.w*i/n,r.y+r.h);
        dctx.moveTo(r.x,r.y+r.h*i/n); dctx.lineTo(r.x+r.w,r.y+r.h*i/n);
      }
      dctx.stroke();
      dctx.strokeStyle='rgba(255,255,255,.92)'; dctx.lineWidth=lw(1.5);
      dctx.strokeRect(r.x,r.y,r.w,r.h);
      // iOS-style corner brackets + edge bars
      const L=Math.min(lw(22),r.w/3,r.h/3), T=lw(4);
      dctx.fillStyle='#fff';
      const cs=[[r.x,r.y,1,1],[r.x+r.w,r.y,-1,1],[r.x+r.w,r.y+r.h,-1,-1],[r.x,r.y+r.h,1,-1]];
      for(const [x,y,sx,sy] of cs){
        dctx.fillRect(sx>0?x-T/2:x-L+T/2, y-T/2, L, T);
        dctx.fillRect(x-T/2, sy>0?y-T/2:y-L+T/2, T, L);
      }
      const mb=Math.min(lw(26),r.w/3), mv=Math.min(lw(26),r.h/3);
      dctx.fillRect(r.x+r.w/2-mb/2, r.y-T/2, mb, T);
      dctx.fillRect(r.x+r.w/2-mb/2, r.y+r.h-T/2, mb, T);
      dctx.fillRect(r.x-T/2, r.y+r.h/2-mv/2, T, mv);
      dctx.fillRect(r.x+r.w-T/2, r.y+r.h/2-mv/2, T, mv);
    }

    /* ----- straighten dial ----- */
    // Straighten, Vertical and Horizontal share one dial, like iOS Photos.
    const ADJ={
      straighten:{label:'STRAIGHTEN',max:45,unit:'°',get:()=>thetaDeg,set:v=>{thetaDeg=v;}},
      vertical:  {label:'VERTICAL',  max:20,unit:'', get:()=>vDeg,    set:v=>{vDeg=v;}},
      horizontal:{label:'HORIZONTAL',max:20,unit:'', get:()=>hDeg,    set:v=>{hDeg=v;}}
    };
    function syncAdjBtns(){
      overlayE.querySelectorAll('.ed-adj').forEach(b=>{
        const k=b.dataset.adj;
        b.classList.toggle('active',k===adjKey);
        b.classList.toggle('valued',Math.abs(ADJ[k].get())>0.01);
        b.setAttribute('aria-checked',String(k===adjKey));
      });
    }
    function drawDial(){
      const w=dial.clientWidth||300, h=40;
      dial.width=Math.round(w*dpr); dial.height=Math.round(h*dpr);
      const a=ADJ[adjKey], val=a.get(), max=a.max;
      const x=dialCtx;
      x.setTransform(dpr,0,0,dpr,0,0);
      x.clearRect(0,0,w,h);
      const cx=w/2;
      for(let v=Math.ceil(val-cx/PPD); v<=Math.floor(val+cx/PPD); v++){
        if(v<-max||v>max) continue;
        const px=cx+(v-val)*PPD, major=v%5===0;
        x.strokeStyle=major?'rgba(255,255,255,.75)':'rgba(255,255,255,.28)';
        x.beginPath(); x.moveTo(px,h-6-(major?13:8)); x.lineTo(px,h-6); x.stroke();
        if(v%15===0){
          x.fillStyle='rgba(255,255,255,.6)';
          x.font='9px "IBM Plex Mono",monospace'; x.textAlign='center';
          x.fillText(String(v),px,10);
        }
      }
      x.fillStyle='#ef5d12';
      x.fillRect(cx-1,h-27,2,22);
      x.beginPath(); x.moveTo(cx-4,h-31); x.lineTo(cx+4,h-31); x.lineTo(cx,h-25); x.closePath(); x.fill();
      const vTxt=val?((val>0?'+':'')+(Math.round(val*10)/10)+a.unit):('0'+a.unit);
      dialVal.textContent=a.label+'\u2002'+vTxt;
      dialVal.style.opacity=val?1:.55;
    }
    function setAdjFromBase(val,base){
      ADJ[adjKey].set(val);
      const cNew=imgToView(base.q);
      crop=shrinkValid({x:cNew.x-base.w/2,y:cNew.y-base.h/2,w:base.w,h:base.h});
      view=targetView();
      drawDial(); render(); syncSessionUI(); syncAdjBtns();
    }
    dial.addEventListener('pointerdown',e=>{
      if(!work||busy||mode!=='crop') return;
      e.preventDefault(); stopAnim();
      try{ dial.setPointerCapture(e.pointerId); }catch(_){}
      dialDrag={x0:e.clientX, v0:ADJ[adjKey].get(),
                q:toImagePt({x:crop.x+crop.w/2,y:crop.y+crop.h/2}), w:crop.w, h:crop.h};
    });
    dial.addEventListener('pointermove',e=>{
      if(!dialDrag||!work) return;
      const max=ADJ[adjKey].max;
      let t=dialDrag.v0-(e.clientX-dialDrag.x0)/PPD;
      t=Math.max(-max,Math.min(max,Math.round(t*10)/10));
      if(Math.abs(t)<0.35) t=0;        // gentle snap at zero, like iOS
      setAdjFromBase(t,dialDrag);
    });
    const endDial=()=>{ if(dialDrag){ dialDrag=null; drawDial(); render(); } };
    dial.addEventListener('pointerup',endDial);
    dial.addEventListener('pointercancel',endDial);

    /* ----- crop-session ops ----- */
    function beginCropSession(){
      cropBase=work;
      sesOrigRatio=work.width/work.height;
      thetaDeg=0; vDeg=0; hDeg=0; adjKey='straighten';
      crop=fullCrop(); sesRot=false; sesFlip=false;
      setRatioChip('free'); ratio=0;
      drawDial(); syncSessionUI(); syncAdjBtns();
    }
    function commitCropSession(){
      if(!work||!cropBase) return;
      if(!sessionChanged()){ cropBase=null; return; }
      pushUndoOf(cropBase);            // the whole session is one undo step
      if((vDeg||hDeg)&&gl){
        setWorkBitmap(bakePerspective());
      }else{
        const out=document.createElement('canvas');
        out.width=Math.max(1,Math.round(crop.w));
        out.height=Math.max(1,Math.round(crop.h));
        const x=out.getContext('2d'), c=imgC();
        x.translate(-crop.x,-crop.y);
        x.translate(c.x,c.y); x.rotate(theta()); x.translate(-c.x,-c.y);
        x.drawImage(work,0,0);
        setWorkBitmap(out);
      }
      thetaDeg=0; vDeg=0; hDeg=0; crop=fullCrop(); sesRot=false; sesFlip=false; cropBase=null;
    }
    function resetSession(){
      if(busy||!work||!cropBase) return;
      setWorkBitmap(cropBase);
      beginCropSession();
      sizeCanvas(); view=targetView(); render();
    }
    function rotate90(){
      if(busy||!work||mode!=='crop') return;
      stopAnim();
      const W=work.width;
      const q=toImagePt({x:crop.x+crop.w/2,y:crop.y+crop.h/2});
      const nc=document.createElement('canvas');
      nc.width=work.height; nc.height=work.width;
      const x=nc.getContext('2d');
      x.translate(0,nc.height); x.rotate(-Math.PI/2); x.drawImage(work,0,0);
      setWorkBitmap(nc);
      const q2={x:q.y,y:W-q.x};                       // the same point after 90° CCW
      const pv=vDeg;                                  // tilt axes rotate with the content
      vDeg=hDeg; hDeg=-pv;
      const c2=imgToView(q2);
      crop=shrinkValid({x:c2.x-crop.h/2,y:c2.y-crop.w/2,w:crop.h,h:crop.w});
      sesRot=true;
      view=targetView(); render(); syncSessionUI(); syncAdjBtns(); drawDial();
    }
    function flipH(){
      if(busy||!work||mode!=='crop') return;
      stopAnim();
      const W=work.width;
      const q=toImagePt({x:crop.x+crop.w/2,y:crop.y+crop.h/2});
      const nc=document.createElement('canvas');
      nc.width=W; nc.height=work.height;
      const x=nc.getContext('2d');
      x.translate(W,0); x.scale(-1,1); x.drawImage(work,0,0);
      setWorkBitmap(nc);
      thetaDeg=-thetaDeg; hDeg=-hDeg;                 // mirroring flips tilt + horizontal keystone
      const c2=imgToView({x:W-q.x,y:q.y});
      crop=shrinkValid({x:c2.x-crop.w/2,y:c2.y-crop.h/2,w:crop.w,h:crop.h});
      sesFlip=!sesFlip;
      view=targetView(); drawDial(); render(); syncSessionUI(); syncAdjBtns();
    }
    function setRatioChip(key){
      aspectsRow.querySelectorAll('.ed-chip').forEach(ch=>{
        ch.classList.toggle('active',ch.dataset.r===key);
        ch.setAttribute('aria-checked',String(ch.dataset.r===key));
      });
    }
    function applyRatio(key){
      if(busy||!work||mode!=='crop') return;
      setRatioChip(key);
      if(key==='free'){ ratio=0; syncSessionUI(); return; }
      let p=key==='orig'?sesOrigRatio:(key.includes(':')?(key.split(':').map(Number).reduce((a,b)=>a/b)):Number(key));
      // orient the preset to the frame's current orientation
      if((crop.w>=crop.h&&p<1)||(crop.w<crop.h&&p>1)) p=1/p;
      ratio=p;
      const c={x:crop.x+crop.w/2,y:crop.y+crop.h/2};
      const area=crop.w*crop.h;
      const w=Math.sqrt(area*p), h=w/p;
      crop=shrinkValid({x:c.x-w/2,y:c.y-h/2,w,h});
      animateView(160); syncSessionUI();
    }
    function syncSessionUI(){ resetBtn.hidden=!(mode==='crop'&&sessionChanged()); }

    /* ----- WebGL image renderer (exact keystone preview + bake) -----
       A 2D canvas can't draw a projective transform; a single GL quad with
       per-vertex homogeneous w renders the homography exactly. The GL canvas
       sits beneath the 2D canvas, which keeps drawing the crop UI. */
    const glCanvas=document.createElement('canvas');
    glCanvas.style.cssText='position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none';
    stage.insertBefore(glCanvas,canvas);
    let gl=null, glProg=null, glPosBuf=null, glUVBuf=null, glTex=null, glTexSrc=null;
    (function glInit(){
      try{ gl=glCanvas.getContext('webgl',{alpha:true,premultipliedAlpha:true,preserveDrawingBuffer:true}); }
      catch(_){ gl=null; }
      if(!gl) return;
      try{
        const sh=(t,code)=>{
          const s=gl.createShader(t);
          gl.shaderSource(s,code); gl.compileShader(s);
          if(!gl.getShaderParameter(s,gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)||'shader');
          return s;
        };
        glProg=gl.createProgram();
        gl.attachShader(glProg,sh(gl.VERTEX_SHADER,
          'attribute vec4 aPos;attribute vec2 aUV;varying vec2 vUV;void main(){gl_Position=aPos;vUV=aUV;}'));
        gl.attachShader(glProg,sh(gl.FRAGMENT_SHADER,
          'precision mediump float;varying vec2 vUV;uniform sampler2D uTex;void main(){gl_FragColor=texture2D(uTex,vUV);}'));
        gl.linkProgram(glProg);
        if(!gl.getProgramParameter(glProg,gl.LINK_STATUS)) throw new Error('link');
        glPosBuf=gl.createBuffer(); glUVBuf=gl.createBuffer();
        glTex=gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D,glTex);
        gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
      }catch(e){ console.warn('editor: WebGL unavailable, perspective disabled',e); gl=null; }
    })();
    function glDraw(mapView,outW,outH){
      if(glTexSrc!==work){
        gl.bindTexture(gl.TEXTURE_2D,glTex);
        gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,work);
        glTexSrc=work;
      }
      const corners=[{x:0,y:0},{x:work.width,y:0},{x:work.width,y:work.height},{x:0,y:work.height}];
      const uv=[[0,0],[1,0],[1,1],[0,1]];
      const P=corners.map(p=>{
        const v=imgToView3(p), m=mapView(v);
        return [(m.x/outW)*2-1, 1-(m.y/outH)*2, v.w];
      });
      const pos=[],uvs=[];
      for(const i of [0,1,2,0,2,3]){
        pos.push(P[i][0]*P[i][2], P[i][1]*P[i][2], 0, P[i][2]);
        uvs.push(uv[i][0],uv[i][1]);
      }
      gl.viewport(0,0,outW,outH);
      gl.clearColor(0,0,0,0); gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(glProg);
      const aPos=gl.getAttribLocation(glProg,'aPos'), aUV=gl.getAttribLocation(glProg,'aUV');
      gl.bindBuffer(gl.ARRAY_BUFFER,glPosBuf);
      gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(pos),gl.STREAM_DRAW);
      gl.enableVertexAttribArray(aPos); gl.vertexAttribPointer(aPos,4,gl.FLOAT,false,0,0);
      gl.bindBuffer(gl.ARRAY_BUFFER,glUVBuf);
      gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(uvs),gl.STREAM_DRAW);
      gl.enableVertexAttribArray(aUV); gl.vertexAttribPointer(aUV,2,gl.FLOAT,false,0,0);
      gl.drawArrays(gl.TRIANGLES,0,6);
    }
    function renderGL(){
      if(glCanvas.width!==canvas.width||glCanvas.height!==canvas.height){
        glCanvas.width=canvas.width; glCanvas.height=canvas.height;
      }
      glDraw(v=>({x:(view.ax+v.x*view.s)*dpr, y:(view.ay+v.y*view.s)*dpr}),
        glCanvas.width, glCanvas.height);
    }
    function bakePerspective(){
      const outW=Math.max(1,Math.round(crop.w)), outH=Math.max(1,Math.round(crop.h));
      glCanvas.width=outW; glCanvas.height=outH;
      glDraw(v=>({x:v.x-crop.x, y:v.y-crop.y}), outW, outH);
      const out=document.createElement('canvas');
      out.width=outW; out.height=outH;
      out.getContext('2d').drawImage(glCanvas,0,0);
      return out;
    }

    /* ----- pan / zoom (frame stays put, image moves) ----- */
    function panBy(d){
      const cand={...crop,x:crop.x-d.x/view.s,y:crop.y-d.y/view.s};
      crop=clampRect(crop,cand);
      view=targetView();
      render();
    }
    function zoomAt(f,mScr){
      const m=toRot(mScr);
      const z={x:m.x+(crop.x-m.x)/f, y:m.y+(crop.y-m.y)/f, w:crop.w/f, h:crop.h/f};
      if(z.w>=minCrop()&&z.h>=minCrop()) crop=clampRect(crop,z);
      view=targetView();
      render();
    }
    stage.addEventListener('wheel',e=>{
      if(!work||busy||mode!=='crop') return;
      e.preventDefault(); stopAnim();
      zoomAt(Math.exp(-e.deltaY*0.0018), localPt(e));
    },{passive:false});

    /* ----- pointer interaction ----- */
    function localPt(e){
      const b=canvas.getBoundingClientRect();
      return {x:e.clientX-b.left,y:e.clientY-b.top};
    }
    function zoneAt(sp){
      const tl=toScreen({x:crop.x,y:crop.y}), br=toScreen({x:crop.x+crop.w,y:crop.y+crop.h});
      const t=26;
      const nx0=Math.abs(sp.x-tl.x)<=t, nx1=Math.abs(sp.x-br.x)<=t;
      const ny0=Math.abs(sp.y-tl.y)<=t, ny1=Math.abs(sp.y-br.y)<=t;
      const inX=sp.x>tl.x-t&&sp.x<br.x+t, inY=sp.y>tl.y-t&&sp.y<br.y+t;
      if(nx0&&ny0) return 'nw'; if(nx1&&ny0) return 'ne';
      if(nx1&&ny1) return 'se'; if(nx0&&ny1) return 'sw';
      if(ny0&&inX) return 'n'; if(ny1&&inX) return 's';
      if(nx0&&inY) return 'w'; if(nx1&&inY) return 'e';
      if(sp.x>tl.x&&sp.x<br.x&&sp.y>tl.y&&sp.y<br.y) return 'pan';
      return null;
    }
    function handleDrag(dg,sp){
      const r0=dg.start, mn=minCrop(), k=dg.kind;
      const p=toRot(sp);                 // view is frozen during a handle drag
      let x0=r0.x,y0=r0.y,x1=r0.x+r0.w,y1=r0.y+r0.h;
      if(ratio){
        const west=k.includes('w'), north=k.includes('n');
        if(k.length===2){                // corner: scale about the opposite corner
          const ax=west?x1:x0, ay=north?y1:y0;
          let w=Math.max(Math.abs(p.x-ax),Math.abs(p.y-ay)*ratio,mn,mn*ratio);
          const h=w/ratio;
          x0=west?ax-w:ax; x1=west?ax:ax+w;
          y0=north?ay-h:ay; y1=north?ay:ay+h;
        }else if(k==='e'||k==='w'){      // edge: scale about the opposite edge centre
          const ax=k==='w'?x1:x0, cy=(y0+y1)/2;
          const w=Math.max(Math.abs(p.x-ax),mn,mn*ratio), h=w/ratio;
          x0=k==='w'?ax-w:ax; x1=k==='w'?ax:ax+w;
          y0=cy-h/2; y1=cy+h/2;
        }else{
          const ay=k==='n'?y1:y0, cx=(x0+x1)/2;
          const h=Math.max(Math.abs(p.y-ay),mn,mn/ratio), w=h*ratio;
          y0=k==='n'?ay-h:ay; y1=k==='n'?ay:ay+h;
          x0=cx-w/2; x1=cx+w/2;
        }
      }else{
        if(k.includes('w')) x0=Math.min(p.x,x1-mn);
        if(k.includes('e')) x1=Math.max(p.x,x0+mn);
        if(k.includes('n')) y0=Math.min(p.y,y1-mn);
        if(k.includes('s')) y1=Math.max(p.y,y0+mn);
      }
      crop=clampRect(crop,{x:x0,y:y0,w:x1-x0,h:y1-y0});
      render();
    }
    canvas.addEventListener('pointerdown',e=>{
      if(!work||busy) return;
      e.preventDefault(); stopAnim();
      try{ canvas.setPointerCapture(e.pointerId); }catch(_){}
      pointers.set(e.pointerId,localPt(e));
      if(mode==='markup'){
        if(pointers.size>1){ shape=null; render(); return; }   // second finger cancels the stroke
        if(textBox){ commitTextBox(); return; }                // tap outside commits the text
        const p=toRot(localPt(e));
        if(tool==='text'){ placeTextBox(p); return; }
        shape={type:tool,color:color,width:strokeW(),pts: tool==='pen'?[p]:[p,p]};
        render(); return;
      }
      if(pointers.size===2){ drag={kind:'pinch',prev:[...pointers.values()].map(p=>({...p}))}; return; }
      const z=zoneAt(localPt(e));
      if(z==='pan') drag={kind:'pan',prev:localPt(e)};
      else if(z) drag={kind:z,start:{...crop}};
      else drag=null;
    });
    canvas.addEventListener('pointermove',e=>{
      if(!work) return;
      const sp=localPt(e);
      if(pointers.has(e.pointerId)) pointers.set(e.pointerId,sp);
      if(mode==='markup'){
        if(!shape) return;
        const p=toRot(sp);
        if(shape.type==='pen'){
          const last=shape.pts[shape.pts.length-1];
          if(Math.hypot(p.x-last.x,p.y-last.y)>1.5/view.s) shape.pts.push(p);
        }else shape.pts[1]=p;
        render(); return;
      }
      if(!drag){
        const z=zoneAt(sp);
        canvas.style.cursor=z==='pan'?'grab':(z?({n:'ns-resize',s:'ns-resize',e:'ew-resize',w:'ew-resize',
          nw:'nwse-resize',se:'nwse-resize',ne:'nesw-resize',sw:'nesw-resize'})[z]:'default');
        return;
      }
      if(drag.kind==='pinch'){
        if(pointers.size<2) return;
        const [a,b]=[...pointers.values()], pr=drag.prev;
        const d0=Math.hypot(pr[0].x-pr[1].x,pr[0].y-pr[1].y)||1;
        const d1=Math.hypot(a.x-b.x,a.y-b.y)||1;
        const mNow={x:(a.x+b.x)/2,y:(a.y+b.y)/2};
        const mPrev={x:(pr[0].x+pr[1].x)/2,y:(pr[0].y+pr[1].y)/2};
        panBy({x:mNow.x-mPrev.x,y:mNow.y-mPrev.y});
        zoomAt(d1/d0,mNow);
        drag.prev=[{...a},{...b}];
        return;
      }
      if(drag.kind==='pan'){
        const d={x:sp.x-drag.prev.x,y:sp.y-drag.prev.y};
        drag.prev=sp;
        panBy(d);
        return;
      }
      handleDrag(drag,sp);
    });
    function endPointer(e){
      if(e) pointers.delete(e.pointerId);
      if(!work) { drag=null; shape=null; return; }
      if(mode==='markup'){
        if(shape&&pointers.size===0) finishShape();
        return;
      }
      if(!drag) return;
      if(drag.kind==='pinch'){
        if(pointers.size>=2) return;
        drag=pointers.size===1?{kind:'pan',prev:[...pointers.values()][0]}:null;
        if(!drag) animateView(160);
        return;
      }
      if(pointers.size===0){
        const wasHandle=drag.kind!=='pan';
        drag=null;
        animateView(wasHandle?200:120);   // iOS-style re-fit after the gesture
      }
    }
    canvas.addEventListener('pointerup',endPointer);
    canvas.addEventListener('pointercancel',endPointer);
    // if pointer capture was unavailable, a release outside must still land
    window.addEventListener('pointerup',endPointer);

    /* ----- markup shapes (drawn in image coordinates) ----- */
    function strokeW(){
      const E=Math.max(work.width,work.height);
      return Math.max(WIDTH_MIN[widthKey], WIDTHS[widthKey]*E);
    }
    function fontPx(sizeKey){
      return Math.max(12, FONT_PCT[sizeKey||widthKey]*Math.max(work.width,work.height));
    }
    function drawShape(c,s){
      const p=s.pts, a=p[0], b=p[p.length-1];
      c.save();
      c.strokeStyle=s.color; c.fillStyle=s.color;
      c.lineWidth=s.width; c.lineJoin='round'; c.lineCap='round';
      if(s.type==='pen'){
        c.beginPath(); c.moveTo(a.x,a.y);
        for(let i=1;i<p.length;i++) c.lineTo(p[i].x,p[i].y);
        c.stroke();
      }else if(s.type==='line'){
        c.beginPath(); c.moveTo(a.x,a.y); c.lineTo(b.x,b.y); c.stroke();
      }else if(s.type==='arrow'){
        const ang=Math.atan2(b.y-a.y,b.x-a.x), head=Math.max(s.width*3,10);
        c.beginPath(); c.moveTo(a.x,a.y);
        c.lineTo(b.x-head*0.6*Math.cos(ang), b.y-head*0.6*Math.sin(ang));
        c.stroke();
        c.beginPath();
        c.moveTo(b.x,b.y);
        c.lineTo(b.x-head*Math.cos(ang-0.42), b.y-head*Math.sin(ang-0.42));
        c.lineTo(b.x-head*Math.cos(ang+0.42), b.y-head*Math.sin(ang+0.42));
        c.closePath(); c.fill();
      }else if(s.type==='box'){
        const r=normRect(a,b); c.strokeRect(r.x,r.y,r.w,r.h);
      }else if(s.type==='ellipse'){
        const r=normRect(a,b);
        c.beginPath(); c.ellipse(r.x+r.w/2,r.y+r.h/2,Math.max(1,r.w/2),Math.max(1,r.h/2),0,0,Math.PI*2); c.stroke();
      }else if(s.type==='cloud'){
        cloudPath(c,normRect(a,b),s.width); c.stroke();
      }
      c.restore();
    }
    function normRect(a,b){
      return {x:Math.min(a.x,b.x),y:Math.min(a.y,b.y),w:Math.abs(b.x-a.x),h:Math.abs(b.y-a.y)};
    }
    // Acrobat-style revision cloud: outward scallops walked clockwise around
    // the rectangle; overlapping sweeps (±0.5 rad) give the classic cusps.
    function cloudPath(c,r,lw){
      // scallop size tracks the IMAGE, not the box, so large clouds keep the
      // small even arcs of an Acrobat revision cloud instead of giant loops
      const E=Math.max(work.width,work.height);
      let seg=Math.max(12, lw*3, E*0.014);
      seg=Math.min(seg, Math.max(8, Math.min(r.w,r.h)/2));
      const pts=[];
      const walk=(x0,y0,x1,y1)=>{
        const len=Math.hypot(x1-x0,y1-y0), n=Math.max(1,Math.round(len/seg));
        for(let i=0;i<n;i++) pts.push({x:x0+(x1-x0)*i/n, y:y0+(y1-y0)*i/n});
      };
      walk(r.x,r.y, r.x+r.w,r.y);
      walk(r.x+r.w,r.y, r.x+r.w,r.y+r.h);
      walk(r.x+r.w,r.y+r.h, r.x,r.y+r.h);
      walk(r.x,r.y+r.h, r.x,r.y);
      if(pts.length<3) return;
      c.beginPath();
      for(let i=0;i<pts.length;i++){
        const a=pts[i], b=pts[(i+1)%pts.length];
        const mx=(a.x+b.x)/2, my=(a.y+b.y)/2;
        const ang=Math.atan2(b.y-a.y,b.x-a.x), rad=Math.hypot(b.x-a.x,b.y-a.y)/2;
        c.arc(mx,my,rad, ang+Math.PI-0.42, ang+0.42, false);
      }
      c.closePath();
    }
    function finishShape(){
      if(!shape) return;
      const s=shape; shape=null;
      const a=s.pts[0], b=s.pts[s.pts.length-1];
      const tiny = s.type==='pen' ? s.pts.length<2
                 : Math.hypot(b.x-a.x,b.y-a.y) < 4/view.s;
      if(!tiny){ pushUndoOf(work); drawShape(wctx,s); }
      render();
    }

    /* ----- text boxes: tap to place, type, drag by the grip; commits on
       tapping elsewhere / switching tools / Done ----- */
    function placeTextBox(p){
      const wrap=document.createElement('div');
      wrap.className='ed-textwrap';
      const grip=document.createElement('div');
      grip.className='ed-textgrip';
      grip.textContent='⠿ drag';
      const box=document.createElement('div');
      box.className='ed-textbox';
      box.contentEditable='true';
      box.spellcheck=false;
      box.setAttribute('role','textbox');
      box.setAttribute('aria-label','Annotation text');
      wrap.appendChild(grip); wrap.appendChild(box);
      stage.appendChild(wrap);
      textBox={wrap,box,grip,pos:{x:p.x,y:p.y},color:color,sizeKey:widthKey};
      styleTextBox(); positionTextBox();
      try{ box.focus(); }catch(_){}
      requestAnimationFrame(()=>{ if(textBox&&textBox.box===box){ try{ box.focus(); }catch(_){} } });
      box.addEventListener('keydown',e=>{
        e.stopPropagation();               // Escape edits the box, not the editor
        if(e.key==='Escape'){ e.preventDefault(); cancelTextBox(); }
      });
      grip.addEventListener('pointerdown',e=>{
        e.preventDefault(); e.stopPropagation();
        try{ grip.setPointerCapture(e.pointerId); }catch(_){}
        const start={x:e.clientX,y:e.clientY,pos:{...textBox.pos}};
        const mv=ev=>{
          if(!textBox) return;
          textBox.pos={x:start.pos.x+(ev.clientX-start.x)/view.s,
                       y:start.pos.y+(ev.clientY-start.y)/view.s};
          positionTextBox();
        };
        const done=()=>{
          grip.removeEventListener('pointermove',mv);
          grip.removeEventListener('pointerup',done);
          grip.removeEventListener('pointercancel',done);
        };
        grip.addEventListener('pointermove',mv);
        grip.addEventListener('pointerup',done);
        grip.addEventListener('pointercancel',done);
      });
    }
    function styleTextBox(){
      if(!textBox) return;
      textBox.box.style.color=textBox.color;
      textBox.box.style.fontSize=(fontPx(textBox.sizeKey)*view.s)+'px';
    }
    function positionTextBox(){
      if(!textBox) return;
      const sp=toScreen(textBox.pos);
      textBox.wrap.style.left=sp.x+'px';
      textBox.wrap.style.top=sp.y+'px';
    }
    function cancelTextBox(){
      if(!textBox) return;
      textBox.wrap.remove(); textBox=null;
    }
    function commitTextBox(){
      if(!textBox) return;
      const tb=textBox;
      const text=tb.box.innerText.replace(/\u00a0/g,' ').replace(/\s+$/,'');
      cancelTextBox();
      if(!text.trim()){ render(); return; }
      pushUndoOf(work);
      const fs=fontPx(tb.sizeKey);
      wctx.save();
      wctx.fillStyle=tb.color;
      wctx.font='600 '+fs+'px "IBM Plex Sans", system-ui, sans-serif';
      wctx.textBaseline='top';
      // small offsets match the contenteditable's border/leading
      const ox=tb.pos.x+4/view.s, oy=tb.pos.y+2/view.s+fs*0.125;
      text.split('\n').forEach((ln,i)=>wctx.fillText(ln,ox,oy+i*fs*1.25));
      wctx.restore();
      render();
    }

    /* ----- undo (blob snapshots) ----- */
    function updateUndoBtn(){ undoBtn.disabled=!undoStack.length; }
    function pushUndoOf(cv){
      restoredPristine=false;
      const p=new Promise(res=>cv.toBlob(res,'image/jpeg',0.92));
      undoStack.push(p);
      if(undoStack.length>UNDO_MAX){ undoStack.shift(); dirtyFloor=true; }
      updateUndoBtn();
    }
    async function doUndo(){
      if(busy||!work) return;
      if(textBox){ cancelTextBox(); render(); return; }   // undo the box being typed
      if(!undoStack.length) return;
      const s=session;
      busy=true; undoBtn.disabled=true;
      try{
        const blob=await undoStack.pop();
        if(s!==session) return;
        if(blob){
          const url=URL.createObjectURL(blob);
          try{
            const img=await loadImage(url);
            if(s!==session) return;
            const c=document.createElement('canvas');
            c.width=img.naturalWidth; c.height=img.naturalHeight;
            c.getContext('2d').drawImage(img,0,0);
            drag=null; shape=null; restoredPristine=false;
            setWorkBitmap(c);
            if(mode==='crop') beginCropSession();
            sizeCanvas(); view=targetView(); drawDial();
          }finally{ URL.revokeObjectURL(url); }
        }
      }catch(e){ console.error('editor undo',e); }
      finally{ busy=false; updateUndoBtn(); render(); }
    }

    /* ----- mode switching ----- */
    function applyModeUI(){
      const cropM=mode==='crop';
      modeCropBtn.classList.toggle('active',cropM);
      modeMarkupBtn.classList.toggle('active',!cropM);
      topCrop.hidden=!cropM; topMarkup.hidden=cropM;
      aspectsRow.hidden=!cropM; dialWrap.hidden=!cropM;
      toolsRow.hidden=cropM;
      glCanvas.style.display=(cropM&&gl)?'':'none';
      canvas.style.cursor=cropM?'default':'crosshair';
      syncSessionUI();
    }
    function setMode(m){
      if(busy||!work||m===mode) return;
      commitTextBox();
      stopAnim(); drag=null; shape=null; pointers.clear();
      if(m==='markup') commitCropSession();   // markup is WYSIWYG on the final frame
      mode=m;
      if(m==='crop') beginCropSession();
      applyModeUI(); updateUndoBtn();
      requestAnimationFrame(()=>{ sizeCanvas(); view=targetView(); render(); });
    }
    modeCropBtn.addEventListener('click',()=>setMode('crop'));
    modeMarkupBtn.addEventListener('click',()=>setMode('markup'));
    $('edRotate').addEventListener('click',rotate90);
    $('edFlip').addEventListener('click',flipH);
    resetBtn.addEventListener('click',resetSession);
    undoBtn.addEventListener('click',doUndo);
    overlayE.querySelectorAll('.ed-adj').forEach(b=>{
      b.setAttribute('role','radio');
      b.addEventListener('click',()=>{
        if(busy||mode!=='crop') return;
        adjKey=b.dataset.adj;
        syncAdjBtns(); drawDial();
      });
    });
    if(!gl){ // no WebGL: keystone can't render — offer straighten only
      overlayE.querySelectorAll('.ed-adj').forEach(b=>{
        if(b.dataset.adj!=='straighten') b.style.display='none';
      });
    }
    aspectsRow.querySelectorAll('.ed-chip').forEach(ch=>{
      ch.setAttribute('role','radio');
      ch.setAttribute('aria-checked',String(ch.classList.contains('active')));
      ch.addEventListener('click',()=>applyRatio(ch.dataset.r));
    });
    overlayE.querySelectorAll('.edtool').forEach(b=>{
      b.addEventListener('click',()=>{
        if(b.dataset.tool!=='text') commitTextBox();
        overlayE.querySelectorAll('.edtool').forEach(x=>x.classList.remove('active'));
        b.classList.add('active'); tool=b.dataset.tool;
      });
    });
    overlayE.querySelectorAll('.edwidth').forEach(b=>{
      b.addEventListener('click',()=>{
        overlayE.querySelectorAll('.edwidth').forEach(x=>x.classList.remove('active'));
        b.classList.add('active'); widthKey=b.dataset.w;
        if(textBox){ textBox.sizeKey=widthKey; styleTextBox(); }
      });
    });
    const swatchWrap=$('edSwatches');
    COLORS.forEach((c,i)=>{
      const b=document.createElement('button');
      b.className='ed-dot'+(i===0?' active':'');
      b.style.background=c;
      b.title=c;
      b.setAttribute('role','radio');
      b.setAttribute('aria-checked',String(i===0));
      b.setAttribute('aria-label','Colour '+c);
      b.addEventListener('click',()=>{
        swatchWrap.querySelectorAll('.ed-dot').forEach(x=>{
          x.classList.remove('active'); x.setAttribute('aria-checked','false');
        });
        b.classList.add('active'); b.setAttribute('aria-checked','true'); color=c;
        if(textBox){ textBox.color=c; styleTextBox(); }
      });
      swatchWrap.appendChild(b);
    });

    /* ----- open / apply / close ----- */
    async function open(photoInst){
      const s=++session;                 // invalidates any pending continuation
      try{
        const img=await loadImage(photoInst.getDisplaySrc());
        if(s!==session) return;
        inst=photoInst;
        undoStack=[]; dirtyFloor=false; restoredPristine=false;
        cancelTextBox();
        drag=null; shape=null; dialDrag=null; pointers.clear(); stopAnim();
        setWorkBitmap(canvasFrom(img));
        mode='crop'; beginCropSession(); applyModeUI(); updateUndoBtn();
        lastFocus=document.activeElement;
        if(!overlayE.open) overlayE.showModal();
        requestAnimationFrame(()=>{
          if(s!==session) return;
          sizeCanvas(); view=targetView(); drawDial(); render();
        });
      }catch(e){ console.error('editor open',e); ping('Could not open editor'); }
    }
    async function restoreOriginal(){
      if(busy||!inst||!work) return;
      const s=session, target=inst;
      busy=true;
      try{
        const img=await loadImage(target.getOriginalSrc());
        if(s!==session||!work) return;
        if(mode==='crop') commitCropSession();
        pushUndoOf(work);
        setWorkBitmap(canvasFrom(img));
        if(mode==='crop') beginCropSession();
        restoredPristine=true;           // Apply now reverts the card for real
        sizeCanvas(); view=targetView(); drawDial(); render();
      }catch(e){ console.error('editor restore',e); ping('Could not load original'); }
      finally{ busy=false; }
    }
    function close(){
      session++;
      if(overlayE.open) overlayE.close();
      stopAnim(); cancelTextBox();
      inst=null; work=null; wctx=null; cropBase=null; undoStack=[];
      drag=null; shape=null; dialDrag=null; pointers.clear();
      dirtyFloor=false; restoredPristine=false; thetaDeg=0; vDeg=0; hDeg=0; crop=null;
      if(lastFocus && document.contains(lastFocus)){ try{ lastFocus.focus(); }catch(_){} }
      lastFocus=null;
    }
    function requestClose(){
      if(!work) return;
      if(isDirty() && !window.confirm('Discard your edits to this photo?')) return;
      close();
    }
    async function apply(){
      if(busy||!work||!inst) return;
      commitTextBox();
      if(!isDirty()){ close(); return; }
      const s=session, target=inst;
      // "Revert" with nothing after it restores the card to the true original
      if(restoredPristine && !sessionChanged()){
        busy=true; applyBtn.disabled=true;
        try{ await target.revertOriginal(); if(s===session) close(); }
        catch(e){ console.error('editor revert',e); ping('Could not restore original'); }
        finally{ busy=false; applyBtn.disabled=false; }
        return;
      }
      busy=true; applyBtn.disabled=true;
      try{
        if(mode==='crop') commitCropSession();
        const blob=await new Promise(res=>work.toBlob(res,'image/jpeg',0.92));
        if(s!==session) return;          // closed mid-encode — treat as cancel
        if(blob) await target.applyEdit(blob);
        if(s===session) close();
      }catch(e){ console.error('editor apply',e); ping('Could not apply edits'); }
      finally{ busy=false; applyBtn.disabled=false; }
    }
    applyBtn.addEventListener('click',apply);
    $('edCancel').addEventListener('click',requestClose);
    $('edOriginal').addEventListener('click',restoreOriginal);
    overlayE.addEventListener('cancel',event=>{event.preventDefault();requestClose();});

    function refit(){
      if(!work) return;
      sizeCanvas(); view=targetView(); drawDial(); render();
      styleTextBox(); positionTextBox();
    }
    function isOpen(){ return !!work; }

    // minimal state hook for automated tests
    window.__geotagEditor={ state:()=>work?{
      mode,thetaDeg,vDeg,hDeg,adjKey,crop:{...crop},workW:work.width,workH:work.height,
      view:{...view},gl:!!gl,textActive:!!textBox,dirty:isDirty()}:null };

    return {open,cancel:requestClose,refit,isOpen};
  };
})(window);
