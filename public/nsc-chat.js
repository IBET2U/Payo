(function () {
  const bubble = document.createElement('div');
  bubble.innerHTML = '💬';
  bubble.style.cssText = 'position:fixed;bottom:24px;right:24px;width:56px;height:56px;background:#1a3a2a;border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:24px;z-index:9999;box-shadow:0 4px 12px rgba(0,0,0,0.3);';

  const iframe = document.createElement('iframe');
  iframe.src = 'https://payoapp.org/nsc-demo';
  iframe.style.cssText = 'position:fixed;bottom:90px;right:24px;width:380px;height:500px;border:none;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,0.3);z-index:9998;display:none;';

  bubble.onclick = () => {
    iframe.style.display = iframe.style.display === 'none' ? 'block' : 'none';
  };

  document.body.appendChild(bubble);
  document.body.appendChild(iframe);
})();
