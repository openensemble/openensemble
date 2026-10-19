// Search spans this profile's conversations, saved results and profile files.
let _searchDebounce = null, _searchRequest = null, _searchGeneration = 0;
let _searchHits = [], _searchFocus = null, _searchTargetRequest = null;
function searchStatus(message) { $('searchResults').replaceChildren(Object.assign(document.createElement('p'), {className:'work-search-status',textContent:message})); }
function openSearch(query = '') {
  _searchFocus = document.activeElement;
  const modal = $('searchModal'), input = $('searchInput');
  modal.style.display = 'flex'; modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal','true'); modal.setAttribute('aria-label','Search your work');
  input.placeholder = 'Search chats, saved results and files'; input.setAttribute('aria-label','Search your work'); input.maxLength=200; input.value = typeof query === 'string' ? query : '';
  if (!$('workSearchKind')) {
    const label = document.createElement('label'); label.className='work-search-filter'; label.textContent='Search in ';
    const select=document.createElement('select');select.id='workSearchKind';select.setAttribute('aria-label','Search category');
    for(const [value,title] of [['all','All work'],['message','Conversations'],['output','Saved results'],['file','Files']])select.add(new Option(title,value));
    label.append(select); input.parentElement.insertAdjacentElement('afterend',label);
    select.addEventListener('change',()=>runSearch(input.value));
    modal.addEventListener('keydown',event=>{
      if(event.key==='Escape'){event.preventDefault();closeSearch();return;}
      if(event.key!=='Tab')return;
      const focusable=[...modal.querySelectorAll('button,input,select,a[href]')].filter(el=>!el.disabled&&el.getClientRects().length);
      if(!focusable.length)return;
      if(event.shiftKey&&document.activeElement===focusable[0]){event.preventDefault();focusable.at(-1).focus();}
      else if(!event.shiftKey&&document.activeElement===focusable.at(-1)){event.preventDefault();focusable[0].focus();}
    });
  }
  input.oninput=()=>{clearTimeout(_searchDebounce);++_searchGeneration;_searchRequest?.abort();_searchDebounce=setTimeout(()=>runSearch(input.value),250);};
  input.onkeydown=event=>{if(event.key==='Enter'){event.preventDefault();clearTimeout(_searchDebounce);runSearch(input.value);}};
  searchStatus('Search message text, saved results, file names and text-file contents in your profile.');
  input.focus(); if(input.value.trim().length>=2)void runSearch(input.value);
}
function closeSearch(){clearTimeout(_searchDebounce);++_searchGeneration;_searchRequest?.abort();$('searchModal').style.display='none';_searchFocus?.focus?.();}
function resetWorkSearch(){
  clearTimeout(_searchDebounce);++_searchGeneration;_searchRequest?.abort();_searchRequest=null;_searchHits=[];_searchFocus=null;
  _searchTargetRequest?.abort();_searchTargetRequest=null;
  if($('searchModal'))$('searchModal').style.display='none';
  if($('searchInput'))$('searchInput').value='';
  $('searchResults')?.replaceChildren();$('workSearchSource')?.close();$('workSearchSource')?.remove();
}
function _searchResultClick(value){
  // Preserve callers of the former agent-only search action.
  if(typeof value==='string'){closeSearch();switchAgent(value);return;}
  const hit=_searchHits[value];if(!hit)return;
  if(typeof preserveChatDraft==='function'&&!preserveChatDraft())return;
  closeSearch(); location.assign(hit.url);
}
function markedSearchText(text,query){
  const fragment=document.createDocumentFragment(),lower=text.toLowerCase(),needle=query.toLowerCase();let start=0,at;
  while((at=lower.indexOf(needle,start))>=0){fragment.append(document.createTextNode(text.slice(start,at)));const mark=document.createElement('mark');mark.textContent=text.slice(at,at+query.length);fragment.append(mark);start=at+query.length;}
  fragment.append(document.createTextNode(text.slice(start)));return fragment;
}
async function runSearch(query){
  query=String(query||'').trim();const generation=++_searchGeneration;_searchRequest?.abort();_searchRequest=new AbortController();
  if(query.length<2){searchStatus('Type at least 2 characters.');return;}
  searchStatus('Searching your work…');
  try{
    const response=await fetch(`/api/search?${new URLSearchParams({q:query,kind:$('workSearchKind')?.value||'all'})}`,{signal:_searchRequest.signal});
    const data=await response.json();if(generation!==_searchGeneration)return;if(!response.ok)throw new Error(data.error||'Search failed.');
    _searchHits=data.results||[];searchStatus(_searchHits.length?`${_searchHits.length} result${_searchHits.length===1?'':'s'}${data.truncated?' · More work matches or lies outside this bounded search. Narrow the phrase or choose a category.':''}`:data.coverage?.limited?'No matches in the bounded search. Try a category or a more recent phrase.':'No matches in your work.');
    _searchHits.forEach((hit,index)=>{
      const button=document.createElement('button');button.type='button';button.className='search-result work-search-result';button.dataset.action='_searchResultClick';button.dataset.args=JSON.stringify([index]);
      const heading=document.createElement('strong');heading.textContent=hit.title||hit.agentName||hit.agent||'Result';
      const meta=document.createElement('small');meta.textContent=[{message:'Conversation',file:'File',output:'Saved result'}[hit.kind]||'Conversation',hit.role,hit.ts?new Date(hit.ts).toLocaleDateString():''].filter(Boolean).join(' · ');
      const excerpt=document.createElement('span');excerpt.append(markedSearchText(String(hit.content||''),query));button.append(heading,meta,excerpt);$('searchResults').append(button);
    });
  }catch(error){if(generation===_searchGeneration&&error.name!=='AbortError')searchStatus(error.message);}
}
function closeSearchSource(){ $('workSearchSource')?.close(); }
async function openWorkSearchTarget(){
  const params=new URLSearchParams(location.search),generation=typeof _authGeneration==='undefined'?null:_authGeneration;
  if(params.get('mailDraft')){await openMailWorkspace({draftId:params.get('mailDraft')});return;}
  let args;
  if(params.has('searchMessage'))args={kind:'message',agent:params.get('agent')||'',project:params.get('project')||'',chat:params.get('chat')||'',key:params.get('searchMessage')};
  else if(params.has('searchOutput'))args={kind:'output',project:params.get('project')||'',id:params.get('searchOutput')};
  else if(params.has('searchFile'))args={kind:'file',fileId:params.get('searchFile')};
  else return;
  _searchTargetRequest?.abort();const request=new AbortController();_searchTargetRequest=request;
  try{
    const response=await fetch(`/api/search/item?${new URLSearchParams(args)}`,{cache:'no-store',signal:request.signal});const item=await response.json();
    if(request.signal.aborted)return;
    if(generation!==null&&(generation!==_authGeneration||_authSuspended))return;
    if(!response.ok)throw new Error(item.error||'This result is no longer available.');
    if(item.kind==='file'){openDocViewer(item.documentId,item.filename,item.mimeType,item.source);return;}
    let dialog=$('workSearchSource');if(!dialog){dialog=document.createElement('dialog');dialog.id='workSearchSource';dialog.className='work-search-source';document.body.append(dialog);}
    dialog.replaceChildren();
    const heading=document.createElement('h2');heading.id='workSearchSourceTitle';heading.textContent=item.title;dialog.setAttribute('aria-labelledby',heading.id);const close=document.createElement('button');close.type='button';close.textContent='Close';close.addEventListener('click',closeSearchSource);
    const header=document.createElement('header');header.append(heading,close);dialog.append(header);
    const intro=document.createElement('p');intro.className='work-search-status';intro.textContent=item.kind==='message'?'Original message and nearby context. This is a saved view; close it to return to your workspace.':`Saved in ${item.projectName}`;dialog.append(intro);
    for(const row of item.context||[item]){
      const article=document.createElement('article');article.className='work-search-source-message';
      const selected=item.kind==='output'||row.messageKey===item.messageKey;article.classList.toggle('selected',selected);
      const byline=document.createElement('small');byline.textContent=[selected?'Selected result':'Context',row.role,row.ts?new Date(row.ts).toLocaleString():''].filter(Boolean).join(' · ');
      const content=document.createElement('div');content.className='markdown-body';content.innerHTML=DOMPurify.sanitize(marked.parse(row.content||''));article.append(byline,content);dialog.append(article);
    }
    if(item.kind==='output'&&item.source?.messageKey&&item.source.agentId){
      const link=document.createElement('a');link.textContent='Open source message';link.href=`/?${new URLSearchParams({project:item.projectId,agent:item.source.agentId,...(item.source.chatId?{chat:item.source.chatId}:{}),searchMessage:item.source.messageKey})}`;dialog.append(link);
    }
    dialog.showModal();dialog.querySelector('.selected')?.scrollIntoView({block:'nearest'});close.focus();
  }catch(error){if(error.name!=='AbortError')showToast(error.message);}
}
