
(function(){
var API_BASE = window.location.origin;
var originalPrompt = '';
function $(id){return document.getElementById(id)}
function getToken(){return localStorage.getItem('admin_token')||''}
function setToken(t){localStorage.setItem('admin_token',t)}
function clearToken(){localStorage.removeItem('admin_token')}
function showScreen(name){
document.querySelectorAll('.screen').forEach(function(s){s.classList.remove('active')});
document.querySelectorAll('.nav-item').forEach(function(n){n.classList.remove('active')});
var view=$('view-'+name);if(view)view.classList.add('active');
var nav=document.querySelector('.nav-item[data-screen="'+name+'"]');if(nav)nav.classList.add('active');
if(name==='panel')fetchAll(getToken());
if(name==='conversations')loadConversations(getToken());
if(name==='prompt')loadPromptEditor(getToken());
if(name==='functions')loadFunctions(getToken());
if(name==='functions')loadFunctions(getToken());
}
function api(path,opts){
opts=opts||{};
opts.headers=opts.headers||{};
opts.headers['Authorization']='Bearer '+getToken();
if(opts.body&&typeof opts.body==='object'){opts.headers['Content-Type']='application/json';opts.body=JSON.stringify(opts.body)}
return fetch(API_BASE+path,opts).then(function(r){return r.json().catch(function(){return{}})})
}
// LOGIN
$('btn-login').addEventListener('click',function(){
var t=$('login-token').value.trim();
if(!t){$('login-feedback').textContent='❌ Digite o token';$('login-feedback').className='feedback error';return}
setToken(t);
api('/admin/status').then(function(d){
if(d&&typeof d.enabled!=='undefined'){
$('login-feedback').textContent='✅ Autenticado!';$('login-feedback').className='feedback success';
setTimeout(function(){$('screen-login').style.display='none';$('screen-panel').classList.add('active');showScreen('panel')},400);
}else{$('login-feedback').textContent='❌ Token inválido';$('login-feedback').className='feedback error';clearToken()}
}).catch(function(){$('login-feedback').textContent='❌ Erro de conexão';$('login-feedback').className='feedback error';clearToken()})
});
$('login-token').addEventListener('keydown',function(e){if(e.key==='Enter')$('btn-login').click()});
$('btn-logout').addEventListener('click',function(){clearToken();location.reload()});
// NAV
document.querySelectorAll('.nav-item').forEach(function(n){n.addEventListener('click',function(){showScreen(this.dataset.screen)})});
// STATUS
function updateStatus(d){
var dot=$('status-dot'),txt=$('status-text'),sub=$('status-sub');
if(!d||typeof d.enabled==='undefined'){dot.className='dot unknown';txt.textContent='Indisponível';sub.textContent='Sem resposta do servidor';return}
if(d.enabled){dot.className='dot on';txt.textContent='IA Ativa';sub.textContent=d.toggledAt?'Desde '+new Date(d.toggledAt).toLocaleString('pt-BR'):'Ativo'}
else{dot.className='dot off';txt.textContent='IA Desativada';sub.textContent=d.toggledAt?'Desde '+new Date(d.toggledAt).toLocaleString('pt-BR'):'Inativo'}
}
function fetchAll(token){
api('/admin/status').then(updateStatus).catch(function(){updateStatus(null)});
api('/admin/logs').then(function(d){
var box=$('log-box');
if(d&&d.logs&&d.logs.length){box.textContent=d.logs.join('\\n');box.scrollTop=box.scrollHeight}
else{box.textContent='Sem logs recentes'}
}).catch(function(){$('log-box').textContent='Erro ao carregar logs'});
}
// TOGGLE
$('btn-enable').addEventListener('click',function(){
this.disabled=true;$('btn-disable').disabled=true;
api('/admin/enable',{method:'POST'}).then(function(d){
updateStatus(d);$('toggle-feedback').textContent='✅ IA ativada!';$('toggle-feedback').className='feedback success';
}).catch(function(e){$('toggle-feedback').textContent='❌ Erro: '+e.message;$('toggle-feedback').className='feedback error'})
.finally(function(){$('btn-enable').disabled=false;$('btn-disable').disabled=false});
});
$('btn-disable').addEventListener('click',function(){
this.disabled=true;$('btn-enable').disabled=true;
api('/admin/disable',{method:'POST'}).then(function(d){
updateStatus(d);$('toggle-feedback').textContent='✅ IA desativada!';$('toggle-feedback').className='feedback success';
}).catch(function(e){$('toggle-feedback').textContent='❌ Erro: '+e.message;$('toggle-feedback').className='feedback error'})
.finally(function(){$('btn-enable').disabled=false;$('btn-disable').disabled=false});
});
// REBUILD
$('btn-rebuild').addEventListener('click',function(){
if(!confirm('Reconstruir o container na VPS? Isso leva ~30s.'))return;
this.disabled=true;$('rebuild-overlay').classList.add('active');$('rebuild-feedback').textContent='⏳ Iniciando rebuild...';$('rebuild-feedback').className='feedback';
api('/admin/rebuild',{method:'POST'}).then(function(d){
if(d&&(d.ok||d.status==='in_progress')){
$('rebuild-feedback').textContent='⏳ Rebuild em andamento...';
var poll=setInterval(function(){
api('/admin/rebuild/status').then(function(s){
if(s&&!s.rebuilding){clearInterval(poll);$('rebuild-overlay').classList.remove('active');$('rebuild-feedback').textContent='✅ Rebuild concluído!';$('rebuild-feedback').className='feedback success';fetchAll(getToken())}
}).catch(function(){clearInterval(poll);$('rebuild-overlay').classList.remove('active');$('rebuild-feedback').textContent='❌ Erro ao verificar status';$('rebuild-feedback').className='feedback error'})
},3000);
}else{$('rebuild-overlay').classList.remove('active');$('rebuild-feedback').textContent='❌ '+(d&&d.error||'Falha no rebuild');$('rebuild-feedback').className='feedback error'}
}).catch(function(e){$('rebuild-overlay').classList.remove('active');$('rebuild-feedback').textContent='❌ Erro: '+e.message;$('rebuild-feedback').className='feedback error'})
.finally(function(){$('btn-rebuild').disabled=false});
});
// CLEAR MEMORY
$('btn-clear-memory').addEventListener('click',function(){
if(!confirm('Apagar TODAS as conversas e handoffs? Essa ação é irreversível.'))return;
this.disabled=true;
api('/admin/clear-memory',{method:'POST'}).then(function(d){
if(d&&d.ok){$('clear-feedback').textContent='✅ Memória limpa!';$('clear-feedback').className='feedback success'}
else{$('clear-feedback').textContent='❌ '+(d&&d.error||'Falha');$('clear-feedback').className='feedback error'}
}).catch(function(e){$('clear-feedback').textContent='❌ Erro: '+e.message;$('clear-feedback').className='feedback error'})
.finally(function(){$('btn-clear-memory').disabled=false});
});
// CONVERSATIONS
function loadConversations(token){
api('/admin/conversations').then(function(d){
var list=$('conv-list');var items=d&&d.conversations?d.conversations:[];
$('conv-count').textContent=items.length;
if(!items.length){list.innerHTML='<div style="padding:20px;text-align:center;color:var(--muted);font-size:.85rem">Nenhuma conversa encontrada</div>';return}
list.innerHTML='';
items.forEach(function(c){
var div=document.createElement('div');div.className='conv-item';
div.innerHTML='<div class="conv-item-phone">'+(c.phone_number||'Desconhecido')+'</div><div class="conv-item-preview">'+(c.last_message||'')+'</div><div class="conv-item-meta"><span class="conv-item-time">'+(c.last_message_at?new Date(c.last_message_at).toLocaleString('pt-BR'):'')+'</span></div>';
div.addEventListener('click',function(){
document.querySelectorAll('.conv-item').forEach(function(i){i.classList.remove('active')});
div.classList.add('active');showConversation(c.phone_number);
});
list.appendChild(div);
});
}).catch(function(){$('conv-list').innerHTML='<div style="padding:20px;text-align:center;color:var(--red);font-size:.85rem">Erro ao carregar</div>'});
}
function showConversation(phone){
$('conv-detail-empty').style.display='none';$('conv-messages').style.display='flex';
$('conv-messages').innerHTML='<div style="text-align:center;color:var(--muted);padding:20px">Carregando...</div>';
api('/admin/conversations/'+encodeURIComponent(phone)).then(function(d){
var msgs=d&&d.messages?d.messages:[];
var container=$('conv-messages');container.innerHTML='';
if(!msgs.length){container.innerHTML='<div style="text-align:center;color:var(--muted);padding:20px">Sem mensagens</div>';return}
msgs.forEach(function(m){
var div=document.createElement('div');div.className='msg '+(m.role==='user'?'user':'assistant');
div.innerHTML=m.content.replace(/\n/g,'<br>')+'<div class="msg-time">'+(m.timestamp?new Date(m.timestamp).toLocaleTimeString('pt-BR'):'')+'</div>';
container.appendChild(div);
});
container.scrollTop=container.scrollHeight;
}).catch(function(){$('conv-messages').innerHTML='<div style="text-align:center;color:var(--red);padding:20px">Erro ao carregar</div>'});
}
// PROMPT EDITOR
function loadPromptEditor(token){
$('prompt-feedback').textContent='Carregando...';$('prompt-feedback').className='feedback';
api('/admin/prompt').then(function(d){
var content=d&&d.prompt?d.prompt:'';
$('prompt-textarea').value=content;originalPrompt=content;
$('prompt-feedback').textContent='✅ Prompt carregado ('+content.length+' chars)';$('prompt-feedback').className='feedback success';
}).catch(function(e){$('prompt-feedback').textContent='❌ Erro: '+e.message;$('prompt-feedback').className='feedback error'});
}
$('btn-save-prompt').addEventListener('click',function(){
this.disabled=true;
var val=$('prompt-textarea').value;
fetch(API_BASE+'/admin/prompt',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+getToken()},body:JSON.stringify({prompt:val})})
.then(function(r){return r.json()}).then(function(d){
if(d&&d.ok){originalPrompt=val;$('prompt-feedback').textContent='✅ Prompt salvo com sucesso ('+val.length+' chars)';$('prompt-feedback').className='feedback success'}
else{$('prompt-feedback').textContent='❌ Erro: '+(d&&d.error||'desconhecido');$('prompt-feedback').className='feedback error'}
}).catch(function(e){$('prompt-feedback').textContent='❌ Erro ao salvar: '+e.message;$('prompt-feedback').className='feedback error'})
.finally(function(){$('btn-save-prompt').disabled=false});
});
$('btn-reset-prompt').addEventListener('click',function(){
if(!confirm('Restaurar o prompt para a última versão salva?'))return;
$('prompt-textarea').value=originalPrompt;$('prompt-feedback').textContent='↩️ Restaurado para versão salva';$('prompt-feedback').className='feedback';
});
// FUNCTIONS EDITOR
var functionsList=[];
var editingFuncIdx=null;
function loadFunctions(token){
$('functions-feedback').textContent='Carregando...';$('functions-feedback').className='feedback';
api('/admin/functions').then(function(d){
functionsList=d&&Array.isArray(d.functions)?d.functions:[];
renderFunctions();
$('functions-feedback').textContent='✅ '+functionsList.length+' funções carregadas';$('functions-feedback').className='feedback success';
}).catch(function(e){$('functions-feedback').textContent='❌ Erro: '+e.message;$('functions-feedback').className='feedback error'});
}
function renderFunctions(){
var c=$('functions-list');if(!c)return;c.innerHTML='';
if(functionsList.length===0){c.innerHTML='<div style="padding:20px;text-align:center;color:var(--muted)">Nenhuma função configurada</div>';return;}
functionsList.forEach(function(f,idx){
var el=document.createElement('div');el.className='func-card';el.draggable=true;el.dataset.idx=idx;
el.innerHTML='<span class="drag-handle">⠿</span><span class="func-icon">'+(f.icon||'⚙️')+'</span><div class="func-info"><div class="func-name">'+(f.name||f.id)+'</div><span class="func-type '+(f.type||'Lógica').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'')+'">'+(f.type||'Lógica')+'</span><div class="func-desc">'+(f.description||'')+'</div></div><label class="func-toggle"><input type="checkbox" '+(f.enabled!==false?'checked':'')+' data-idx="'+idx+'"><span class="slider"></span></label><button class="func-edit-btn" data-idx="'+idx+'">✏️ Editar</button>';
c.appendChild(el);
});
initDragAndDrop();
c.querySelectorAll('.func-toggle input').forEach(function(cb){cb.addEventListener('change',function(){var i=parseInt(this.dataset.idx);functionsList[i].enabled=this.checked})});
c.querySelectorAll('.func-edit-btn').forEach(function(btn){btn.addEventListener('click',function(){openFuncModal(parseInt(this.dataset.idx))})});
}
function initDragAndDrop(){
var c=$('functions-list');var dragSrc=null;
c.querySelectorAll('.func-card').forEach(function(card){
card.addEventListener('dragstart',function(){dragSrc=this;this.classList.add('dragging')});
card.addEventListener('dragend',function(){this.classList.remove('dragging');dragSrc=null});
card.addEventListener('dragover',function(e){e.preventDefault()});
card.addEventListener('drop',function(e){
e.preventDefault();if(dragSrc===this)return;
var fromIdx=parseInt(dragSrc.dataset.idx);var toIdx=parseInt(this.dataset.idx);
var item=functionsList.splice(fromIdx,1)[0];functionsList.splice(toIdx,0,item);
renderFunctions();
});
});
}
function openFuncModal(idx){
editingFuncIdx=idx;var f=functionsList[idx];
$('func-modal-title').textContent=idx>=0?'Editar Função':'Nova Função';
$('func-edit-name').value=f?f.name:'';$('func-edit-type').value=f?f.type||'Lógica':'Lógica';
$('func-edit-icon').value=f?f.icon||'\u2699\uFE0F':'';$('func-edit-desc').value=f?f.description||'';
$('func-modal-overlay').classList.add('active');
}
$('btn-func-cancel').addEventListener('click',function(){$('func-modal-overlay').classList.remove('active');editingFuncIdx=null});
$('btn-func-save').addEventListener('click',function(){
var name=$('func-edit-name').value.trim();if(!name){alert('Nome é obrigatório');return;}
var obj={id:name.replace(/\s+/g,'_'),name:name,type:$('func-edit-type').value,icon:$('func-edit-icon').value||'\u2699\uFE0F',description:$('func-edit-desc').value.trim(),enabled:true};
if(editingFuncIdx>=0){obj.enabled=functionsList[editingFuncIdx].enabled!==false;functionsList[editingFuncIdx]=obj}else{functionsList.push(obj)}
$('func-modal-overlay').classList.remove('active');editingFuncIdx=null;renderFunctions();
});
$('btn-add-function').addEventListener('click',function(){openFuncModal(-1)});
$('btn-save-functions').addEventListener('click',function(){
this.disabled=true;$('functions-feedback').textContent='Salvando...';$('functions-feedback').className='feedback';
fetch(API_BASE+'/admin/functions',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+getToken()},body:JSON.stringify({functions:functionsList})})
.then(function(r){return r.json()}).then(function(d){
if(d&&d.ok){$('functions-feedback').textContent='✅ '+functionsList.length+' funções salvas com sucesso!';$('functions-feedback').className='feedback success'}
else{$('functions-feedback').textContent='❌ Erro: '+(d&&d.error||'desconhecido');$('functions-feedback').className='feedback error'}
}).catch(function(e){$('functions-feedback').textContent='❌ Erro ao salvar: '+e.message;$('functions-feedback').className='feedback error'})
.finally(function(){$('btn-save-functions').disabled=false});
});
// AUTO-LOGIN
var saved=getToken();
if(saved){$('screen-login').style.display='none';$('screen-panel').classList.add('active');showScreen('panel')}
// AUTO-REFRESH
setInterval(function(){var p=$('screen-panel');if(p&&p.classList.contains('active')){var t=getToken();if(t){api('/admin/status').then(updateStatus).catch(function(){})}}},5000);
})();
