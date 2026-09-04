/** 后端对当前一次性连接票据的页面裁决。 */
export type ConnectionPageState =
  | { status: "valid"; mode: "initial"; expiresAtMs: number; remainingMs: number }
  | { status: "valid"; mode: "relogin"; expiresAtMs: number; remainingMs: number; maskedLogin: string }
  | { status: "invalid" };

/** 渲染自包含的钱迹账号连接页面。 */
export function connectionPage(nonce: string, state: ConnectionPageState): string {
  const initialState = JSON.stringify(state).replaceAll("<", "\\u003c");
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>连接钱迹账号</title>
  <style>
    :root{--ink:#18201c;--muted:#5d6862;--surface:#fff;--canvas:#f2f5f1;--accent:#22684a;--accent-hover:#19543b;--line:#cbd4ce;--focus:#0b5a38;--danger:#a12d2d;--danger-bg:#fff3f1;--success-bg:#edf8f1}
    *{box-sizing:border-box}
    ::selection{background:#b9dfca;color:#10251a}
    body{min-height:100vh;min-height:100dvh;margin:0;padding:clamp(1.25rem,5vw,4rem) 1rem;display:grid;place-items:center;background:radial-gradient(circle at 50% 0,#fff 0,transparent 38rem),var(--canvas);color:var(--ink);font:16px/1.6 system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
    main{width:min(100%,29rem)}
    .surface{background:var(--surface);border-radius:16px;padding:clamp(1.5rem,6vw,2.5rem);box-shadow:0 20px 55px -34px rgba(22,50,36,.55)}
    h1,h2,p{margin-block-start:0}
    h1{margin-block-end:.6rem;font-size:clamp(1.75rem,7vw,2.25rem);line-height:1.18;letter-spacing:-.03em}
    h2{margin-block-end:.5rem;font-size:1.45rem;line-height:1.25;letter-spacing:-.02em}
    .lead{margin-block-end:1.5rem;color:var(--muted)}
    .notice{margin-block:0 1.6rem;padding:.8rem 1rem;border-radius:12px;background:#eef3ef;color:#34423a;font-size:.925rem}
    .account-summary{margin:0;padding:.8rem .9rem;border-radius:12px;background:#f3f6f4;overflow-wrap:anywhere}
    .account-summary span{display:block;color:var(--muted);font-size:.82rem;font-weight:600}
    .account-summary strong{display:block;margin-block-start:.12rem;font-size:1.05rem}
    form{display:grid;gap:1.1rem}
    label{display:grid;gap:.45rem;font-weight:650}
    input,button{width:100%;font:inherit}
    input{min-height:3rem;padding:.7rem .85rem;border:1px solid var(--line);border-radius:12px;background:#fff;color:var(--ink);caret-color:var(--accent);transition:border-color .16s ease,box-shadow .16s ease}
    input::placeholder{color:#68746d;opacity:1}
    input:hover{border-color:#9eaca4}
    input:focus-visible,button:focus-visible{outline:3px solid var(--focus);outline-offset:2px}
    input:disabled{background:#eef1ef;color:#737d77;cursor:not-allowed}
    button{min-height:3.1rem;margin-block-start:.25rem;border:0;border-radius:12px;padding:.75rem 1rem;background:var(--accent);color:#fff;font-weight:750;cursor:pointer;box-shadow:0 10px 24px -16px rgba(34,104,74,.9);transition:background .16s ease,transform .16s ease,box-shadow .16s ease}
    button:hover:not(:disabled){background:var(--accent-hover);box-shadow:0 13px 28px -17px rgba(25,84,59,.95)}
    button:active:not(:disabled){transform:translateY(1px)}
    button:disabled{opacity:.62;cursor:not-allowed}
    button[aria-busy="true"]{cursor:wait}
    button[aria-busy="true"] .button-label::before{content:"";display:inline-block;width:.85rem;height:.85rem;margin-inline-end:.55rem;border:2px solid currentColor;border-inline-end-color:transparent;border-radius:50%;vertical-align:-.08rem;animation:spin .8s linear infinite}
    #result{display:block;min-height:1.6rem;margin-block-start:.1rem;font-size:.925rem;overflow-wrap:anywhere}
    #result[data-state="error"]{padding:.7rem .8rem;border-radius:10px;background:var(--danger-bg);color:var(--danger);font-weight:650}
    #result[data-state="info"]{color:var(--muted)}
    .privacy{margin:1.25rem 0 0;color:var(--muted);font-size:.82rem;text-align:center}
    dialog{width:min(calc(100% - 2rem),25rem);border:0;border-radius:16px;padding:0;background:var(--surface);color:var(--ink);box-shadow:0 25px 70px -25px rgba(13,32,23,.65)}
    dialog::backdrop{background:rgba(17,30,23,.46)}
    .success-content{padding:2rem;text-align:center}
    .success-mark{display:block;width:3rem;height:3rem;margin:0 auto 1.15rem}
    .success-mark circle{fill:var(--success-bg)}
    .success-mark path{fill:none;stroke:var(--accent);stroke-width:2.5;stroke-linecap:round;stroke-linejoin:round}
    .success-mark .expired-path{display:none}
    dialog[data-state="invalid"] .success-mark circle{fill:var(--danger-bg)}
    dialog[data-state="invalid"] .success-mark path{stroke:var(--danger)}
    dialog[data-state="invalid"] .success-path{display:none}
    dialog[data-state="invalid"] .expired-path{display:block}
    .success-content p{margin-block-end:1.25rem;color:var(--muted)}
    .success-fallback{margin:0;padding:1rem;border-radius:12px;background:var(--success-bg);text-align:center;font-weight:700}
    [hidden]{display:none!important}
    @keyframes spin{to{transform:rotate(360deg)}}
    @media (max-width:28rem){.surface{padding:1.35rem}.notice{padding:.75rem .85rem}}
    @media (max-width:28rem) and (max-height:48rem){body{padding-block:.75rem}.surface{padding-block:1rem}.lead,.notice{margin-block-end:.9rem}form{gap:.9rem}.privacy{margin-block-start:.8rem}}
    @media (prefers-reduced-motion:reduce){*,*::before,*::after{scroll-behavior:auto!important;transition:none!important;animation-duration:.01ms!important;animation-iteration-count:1!important}}
    @media (forced-colors:active){input,button,.notice,#result{border:1px solid CanvasText}.success-mark circle{fill:Canvas}.success-mark path{stroke:CanvasText}}
  </style>
</head>
<body>
  <main>
    <section class="surface" aria-labelledby="page-title">
      <h1 id="page-title">连接钱迹账号</h1>
      <p class="lead">登录后即可在原对话中查询和管理钱迹数据</p>
      <p class="notice" id="link-note" hidden></p>
      <form id="binding" hidden>
        <label id="login-field" for="login">钱迹账号
          <input id="login" autocomplete="username" placeholder="邮箱或手机号" required maxlength="320">
        </label>
        <p id="account-summary" class="account-summary" hidden><span>当前账号</span><strong id="masked-login"></strong></p>
        <label for="password">钱迹密码
          <input id="password" type="password" autocomplete="current-password" required maxlength="1024">
        </label>
        <button id="submit" type="submit"><span class="button-label">登录并连接</span></button>
        <output id="result" role="status" aria-live="polite"></output>
      </form>
      <p id="success-fallback" class="success-fallback" tabindex="-1" hidden>请手动关闭本页，稍后返回原对话使用账单功能</p>
      <p class="privacy">登录账号用于后续重新登录，密码和密码摘要不会保存</p>
    </section>
  </main>
  <dialog id="success-dialog" aria-labelledby="success-title" aria-describedby="success-message">
    <div class="success-content">
      <svg class="success-mark" viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="24"/><path class="success-path" d="M14.5 24.5 21 31l13-14"/><path class="expired-path" d="M24 13v13m0 8v.2"/></svg>
      <h2 id="success-title">连接成功</h2>
      <p id="success-message">账单正在同步，请稍后返回原对话使用账单功能</p>
      <button id="close-page" type="button">关闭页面</button>
    </div>
  </dialog>
  <script nonce="${nonce}">
    const initialState=${initialState};
    /** 在浏览器内计算密码的 MD5 摘要，避免提交明文密码。 */
    function md5(value){
      const input=new TextEncoder().encode(value);
      const size=Math.ceil((input.length+9)/64)*64;
      const bytes=new Uint8Array(size);
      bytes.set(input);bytes[input.length]=128;
      const view=new DataView(bytes.buffer);
      const bitLength=input.length*8;
      view.setUint32(size-8,bitLength>>>0,true);
      view.setUint32(size-4,Math.floor(bitLength/4294967296),true);
      const shifts=[
        7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,
        5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,
        4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,
        6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21
      ];
      const constants=Array.from({length:64},(_,i)=>Math.floor(Math.abs(Math.sin(i+1))*4294967296)>>>0);
      let a0=1732584193,b0=4023233417,c0=2562383102,d0=271733878;
      for(let offset=0;offset<size;offset+=64){
        const words=Array.from({length:16},(_,i)=>view.getUint32(offset+i*4,true));
        let a=a0,b=b0,c=c0,d=d0;
        for(let i=0;i<64;i++){
          let f,g;
          if(i<16){f=(b&c)|(~b&d);g=i}
          else if(i<32){f=(d&b)|(~d&c);g=(5*i+1)%16}
          else if(i<48){f=b^c^d;g=(3*i+5)%16}
          else{f=c^(b|~d);g=(7*i)%16}
          const sum=(a+f+constants[i]+words[g])>>>0;
          const rotated=(sum<<shifts[i])|(sum>>>(32-shifts[i]));
          a=d;d=c;c=b;b=(b+rotated)>>>0;
        }
        a0=(a0+a)>>>0;b0=(b0+b)>>>0;c0=(c0+c)>>>0;d0=(d0+d)>>>0;
      }
      return [a0,b0,c0,d0].flatMap(word=>[0,8,16,24].map(shift=>((word>>>shift)&255).toString(16).padStart(2,'0'))).join('');
    }

    const form=document.querySelector('#binding');
    const pageTitle=document.querySelector('#page-title');
    const lead=document.querySelector('.lead');
    const loginField=document.querySelector('#login-field');
    const login=document.querySelector('#login');
    const accountSummary=document.querySelector('#account-summary');
    const maskedLogin=document.querySelector('#masked-login');
    const password=document.querySelector('#password');
    const submit=document.querySelector('#submit');
    const submitLabel=submit.querySelector('.button-label');
    const result=document.querySelector('#result');
    const linkNote=document.querySelector('#link-note');
    const successDialog=document.querySelector('#success-dialog');
    const dialogTitle=document.querySelector('#success-title');
    const dialogMessage=document.querySelector('#success-message');
    const closePage=document.querySelector('#close-page');
    const successFallback=document.querySelector('#success-fallback');
    const query=new URLSearchParams(location.search);
    let ticket=query.get('ticket')||'';
    let expiryTimer;
    history.replaceState(null,'',location.pathname);

    function showResult(message,state){
      result.textContent=message;
      result.dataset.state=state;
      result.setAttribute('role',state==='error'?'alert':'status');
    }
    function disableForm(){
      login.disabled=true;password.disabled=true;submit.disabled=true;
    }
    function showDialog(state){
      form.hidden=true;
      if(expiryTimer!==undefined){clearTimeout(expiryTimer);expiryTimer=undefined}
      const invalid=state==='invalid';
      const relogin=initialState.status==='valid'&&initialState.mode==='relogin';
      successDialog.dataset.state=state;
      dialogTitle.textContent=invalid?'链接已失效':relogin?'重新登录成功':'连接成功';
      dialogMessage.textContent=invalid?'请返回原对话重新获取链接':'账单正在同步，请稍后返回原对话使用账单功能';
      closePage.textContent='关闭页面';
      if(!successDialog.open){
        if(typeof successDialog.showModal==='function')successDialog.showModal();
        else successDialog.setAttribute('open','');
      }
      closePage.focus();
    }
    function showInvalid(){
      ticket='';disableForm();showDialog('invalid');
    }

    const validMode=initialState.status==='valid'&&(initialState.mode==='initial'||(initialState.mode==='relogin'&&typeof initialState.maskedLogin==='string'&&initialState.maskedLogin.length>0));
    if(!validMode||!/^[a-f0-9]{64}$/.test(ticket)||!Number.isSafeInteger(initialState.expiresAtMs)||!Number.isSafeInteger(initialState.remainingMs)||initialState.remainingMs<=0){
      showInvalid();
    }else{
      const relogin=initialState.mode==='relogin';
      if(relogin){
        document.title='重新登录钱迹账号';
        pageTitle.textContent='重新登录钱迹账号';
        lead.hidden=true;
        loginField.hidden=true;login.required=false;
        maskedLogin.textContent=initialState.maskedLogin;accountSummary.hidden=false;
        submitLabel.textContent='重新登录';
      }
      const expiryText=new Intl.DateTimeFormat('zh-CN',{month:'long',day:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(initialState.expiresAtMs);
      linkNote.textContent='链接有效至 '+expiryText;
      linkNote.hidden=false;
      form.hidden=false;
      (relogin?password:login).focus();
      expiryTimer=setTimeout(showInvalid,initialState.remainingMs);
    }

    form.addEventListener('submit',async event=>{
      event.preventDefault();
      if(!ticket)return;
      submit.disabled=true;submit.setAttribute('aria-busy','true');submitLabel.textContent='正在连接';
      showResult('正在连接，请稍候…','info');
      try{
        const response=await fetch('/connect',{
          method:'POST',
          headers:{'authorization':'Bearer '+ticket,'content-type':'application/json'},
          body:JSON.stringify(initialState.mode==='relogin'?{password:md5(password.value)}:{login:login.value,password:md5(password.value)})
        });
        const body=await response.json();
        if(response.ok){
          ticket='';password.value='';
          showResult('', '');showDialog('success');
        }else{
          const invalid=body.error?.code==='BINDING_LINK_INVALID';
          if(invalid)showInvalid();
          else{
            const accountMismatch=['QIANJI_ACCOUNT_MISMATCH','QIANJI_LOGIN_ACCOUNT_LOCKED'].includes(body.error?.code);
            const message=body.error?.code==='QIANJI_LOGIN_REJECTED'?'账号或密码不正确，请检查后重试':accountMismatch?'登录账号与当前已连接账号不一致':'连接失败，'+(body.error?.message||'请稍后重试');
            showResult(message,'error');
            password.focus();password.select();
          }
        }
      }catch{
        showResult('网络连接失败，请检查网络后重试','error');
        password.focus();
      }finally{
        submit.removeAttribute('aria-busy');submitLabel.textContent='登录并连接';
        if(ticket){submit.disabled=false;submitLabel.textContent=initialState.mode==='relogin'?'重新登录':'登录并连接'}
      }
    });

    successDialog.addEventListener('cancel',event=>{event.preventDefault();closePage.focus()});
    closePage.addEventListener('click',()=>{
      window.close();
      if(history.length>1)history.back();
      setTimeout(()=>{
        if(!document.hidden){
          if(typeof successDialog.close==='function')successDialog.close();
          else successDialog.removeAttribute('open');
          successFallback.textContent=successDialog.dataset.state==='invalid'?'浏览器未能自动关闭，请手动关闭本页并返回原对话重新获取链接':'浏览器未能自动关闭，请手动关闭本页，稍后返回原对话使用账单功能';
          successFallback.hidden=false;successFallback.focus();
        }
      },120);
    });
  </script>
</body>
</html>`;
}
