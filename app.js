(() => {
  'use strict';
  const STORAGE_KEY = 'field-operations-v1';
  const DEFAULT_KINDS = ['Сев', 'Внесение удобрений', 'Опрыскивание', 'Обработка почвы', 'Уборка', 'Другая работа'];
  const DEFAULT_TYPES = [{id:'other',name:'Другая работа'},{id:'seeding',name:'Сев'},{id:'chemical',name:'Химическая обработка'}];
  const COLORS = ['#76926d','#bc9b65','#8099aa','#ab887d','#8c86a7','#719b92','#bb826e','#8ea076'];
  const $ = (id) => document.getElementById(id);
  const map = L.map('map', { zoomControl: false }).setView([51.105, 44.55], 11);
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  const streetLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
  });
  const satelliteLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19, attribution: 'Tiles &copy; Esri'
  }).addTo(map);
  L.control.layers({ '🛰️ Спутник': satelliteLayer, '🗺️ Карта': streetLayer }, null, { position: 'topright' }).addTo(map);
  const editableFields = L.featureGroup().addTo(map);

  let state = loadState();
  let activeFilter = 'all';
  let selectedId = null;
  let toastTimer;
  let supabaseClient = null;
  let currentSession = null;
  let currentFarmId = null;
  let saveTimer = null;
  let realtimeChannel = null;
  let authBusy = false;
  let hasMigratedLocalData = localStorage.getItem('field-operations-cloud-migrated-v1') === 'true';
  const deviceId = localStorage.getItem('field-operations-device-v1') || (() => { const value = uid(); localStorage.setItem('field-operations-device-v1', value); return value; })();
  const layerById = new Map();
  if (L.Control.Draw) {
    new L.Control.Draw({ position: 'topleft', draw: false, edit: { featureGroup: editableFields, remove: false } }).addTo(map);
  }

  function loadState() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      const customTypes=Array.isArray(raw.operationTypes) ? raw.operationTypes.filter(type=>type?.id&&!DEFAULT_TYPES.some(base=>base.id===type.id)) : [];
      return { fields: Array.isArray(raw.fields) ? raw.fields : [], kinds: Array.isArray(raw.kinds) ? raw.kinds : [...DEFAULT_KINDS], operationTypes:[...DEFAULT_TYPES,...customTypes], importedAt: raw.importedAt || '', campaigns:Array.isArray(raw.campaigns)?raw.campaigns:[],shiftLogs:Array.isArray(raw.shiftLogs)?raw.shiftLogs:[],rainfallLogs:Array.isArray(raw.rainfallLogs)?raw.rainfallLogs:[] };
    } catch { return { fields: [], kinds: [...DEFAULT_KINDS], operationTypes:[...DEFAULT_TYPES], importedAt: '', campaigns:[],shiftLogs:[],rainfallLogs:[] }; }
  }
  function save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    render();
    if (supabaseClient && currentSession && currentFarmId) {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => { void saveCloudState(); }, 500);
    }
  }
  function uid() { return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`; }
  function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function toast(message) { const el = $('toast'); el.textContent = message; el.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 2600); }
  function areaHa(rings) {
    const R = 6378137;
    const ringArea = (ring) => {
      let total = 0;
      for (let i=0, j=ring.length-1; i<ring.length; j=i++) {
        const [lon1,lat1] = ring[j], [lon2,lat2] = ring[i];
        total += (lon2-lon1) * Math.PI/180 * (2 + Math.sin(lat1*Math.PI/180) + Math.sin(lat2*Math.PI/180));
      }
      return Math.abs(total * R * R / 2);
    };
    if (!rings?.length) return 0;
    return Math.max(0, ringArea(rings[0]) - rings.slice(1).reduce((n,r) => n + ringArea(r), 0)) / 10000;
  }
  function parseCoordinates(text) {
    return (text || '').trim().split(/\s+/).map(pair => pair.split(',').slice(0,2).map(Number)).filter(p => p.length===2 && p.every(Number.isFinite));
  }
  function parseKml(xmlText) {
    const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
    if (doc.querySelector('parsererror')) throw new Error('Файл не удалось прочитать как KML/XML.');
    const placemarks = [...doc.getElementsByTagNameNS('*', 'Placemark')];
    if (!placemarks.length) throw new Error('В KML не найдено ни одного объекта.');
    const parsed = [];
    placemarks.forEach((pm, index) => {
      const polygons = [...pm.getElementsByTagNameNS('*', 'Polygon')];
      polygons.forEach((polygon, partIndex) => {
        const rings = [...polygon.getElementsByTagNameNS('*', 'LinearRing')].map(r => parseCoordinates(r.getElementsByTagNameNS('*','coordinates')[0]?.textContent)).filter(r => r.length > 3);
        if (!rings.length) return;
        const name = pm.getElementsByTagNameNS('*','name')[0]?.textContent?.trim() || '';
        const description = pm.getElementsByTagNameNS('*','description')[0]?.textContent || '';
        const cleanDescription = description.replace(/<br\s*\/?\s*>/gi,' ').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
        const label = cleanDescription || name || `Поле ${index+1}`;
        const num = index+1;
        parsed.push({ id: uid(), sourceId: label, name: name || cleanDescription.replace(/\s*№.*$/,'') || `Поле ${num}${partIndex ? ` · ${partIndex+1}` : ''}`, geometry: rings, area: areaHa(rings), operations: [], color: COLORS[index % COLORS.length] });
      });
    });
    if (!parsed.length) throw new Error('В KML нет полигонов с координатами.');
    return parsed;
  }
  function operationState(field) {
    const open = field.operations.filter(o => o.status !== 'done');
    return open.some(o => o.status === 'active') ? 'active' : open.length ? 'planned' : 'idle';
  }
  function fieldColor(field) { const s=operationState(field); return s==='active' ? '#d7a34e' : s==='planned' ? '#71916a' : field.color || '#81947a'; }
  function shapeLatLngs(field) { return field.geometry.map(r => r.map(([lon,lat]) => [lat,lon])); }
  function polygonStyle(field, selected=false) { return { color: selected ? '#294e32' : '#fff', weight: selected ? 3 : 1.6, opacity: .95, fillColor: fieldColor(field), fillOpacity: selected ? .67 : .48 }; }
  function addLayer(field) {
    const polygon = L.polygon(shapeLatLngs(field), polygonStyle(field)).addTo(editableFields);
    polygon._fieldId = field.id;
    polygon.bindTooltip(escapeHtml(field.name), { permanent:true, direction:'center', className:'field-map-label', opacity:.96, interactive:false });
    polygon.on('click', () => openField(field.id));
    layerById.set(field.id, polygon);
  }
  function rebuildMap() {
    editableFields.clearLayers(); layerById.clear();
    state.fields.forEach(addLayer);
    if (state.fields.length && !selectedId) {
      const group = L.featureGroup([...layerById.values()]);
      map.fitBounds(group.getBounds(), { padding:[24,24], maxZoom:14 });
    }
  }
  map.on(L.Draw?.Event?.EDITED || 'draw:edited', event => {
    event.layers.eachLayer(layer => {
      const field = state.fields.find(item => item.id === layer._fieldId);
      if (!field) return;
      const geometry = layer.toGeoJSON().geometry;
      if (geometry?.type !== 'Polygon') return;
      field.geometry = geometry.coordinates;
      field.area = areaHa(field.geometry);
      const tooltip = layer.getTooltip();
      if (tooltip) tooltip.setLatLng(layer.getBounds().getCenter());
    });
    save();
    toast('Границы и площадь полей сохранены в этом браузере');
  });
  function latestOperation(field) {
    const operations = [...field.operations].sort((a,b) => (b.date || '').localeCompare(a.date || ''));
    return operations.find(o => o.status !== 'done') || operations[0] || null;
  }
  function displayOperation(op) { if (!op) return 'Пока без операций'; const status = {planned:'запланировано',active:'в работе',done:'завершено'}[op.status] || ''; return `${op.kind} · ${status}`; }
  function render() {
    $('field-count').textContent = state.fields.length;
    const active = state.fields.filter(f => operationState(f)==='active').length;
    const planned = state.fields.filter(f => operationState(f)==='planned').length;
    $('count-all').textContent = state.fields.length; $('count-active').textContent = active; $('count-planned').textContent = planned;
    $('summary-text').textContent = state.fields.length ? `${state.fields.length} полей · ${active} в работе` : 'Загрузите карту полей';
    $('farm-caption').textContent = state.importedAt ? `Импортировано ${state.importedAt}` : 'Импортируйте KML с контурами полей';
    const query = $('field-search').value.trim().toLowerCase();
    const fields = state.fields.filter(f => {
      const status = operationState(f);
      return (activeFilter==='all' || status===activeFilter) && (!query || `${f.name} ${f.sourceId}`.toLowerCase().includes(query));
    }).sort((a,b) => a.name.localeCompare(b.name,'ru',{numeric:true}));
    const host = $('field-list');
    if (!fields.length) {
      host.innerHTML = state.fields.length ? '<div class="empty-state"><b>Ничего не найдено</b>Измените фильтр или поисковый запрос.</div>' : '<div class="empty-state"><b>Начните с карты полей</b>Загрузите ваш KML-файл, чтобы увидеть контуры и вести журнал работ.</div>';
    } else host.innerHTML = fields.map(f => {
      const op = latestOperation(f), status = operationState(f);
      const stateLabel = status==='active' ? 'В работе' : status==='planned' ? 'Запланировано' : op ? 'Завершено' : 'Без работ';
      const number = (f.name.match(/[\d]+/) || [''])[0];
      return `<article class="field-card ${f.id===selectedId?'selected':''}" data-id="${escapeHtml(f.id)}"><span class="field-swatch" style="background:${fieldColor(f)}22;color:${fieldColor(f)}">${escapeHtml(number || '⌑')}</span><span class="field-card-main"><strong>${escapeHtml(f.name)}</strong><small>${escapeHtml(displayOperation(op))}</small></span><span class="field-card-side"><strong>${f.area.toFixed(1)} га</strong><span class="state-pill ${status==='active'?'active':op?.status==='done'?'done':''}">${stateLabel}</span></span></article>`;
    }).join('');
    host.querySelectorAll('.field-card').forEach(card => card.addEventListener('click', () => openField(card.dataset.id)));
    state.fields.forEach(field => { const layer=layerById.get(field.id); if(layer) layer.setStyle(polygonStyle(field,field.id===selectedId)); });
  }
  function openField(id) {
    const field=state.fields.find(f=>f.id===id); if(!field) return;
    selectedId=id; $('dialog-title').textContent=field.name; $('field-name').value=field.name; $('field-area').textContent=`${field.area.toFixed(2)} га`; $('field-source-id').textContent=field.sourceId || 'Импортированное поле';
    renderOperations(field); $('field-dialog').showModal();
    const layer=layerById.get(id); if(layer) map.flyToBounds(layer.getBounds(), {padding:[50,50],maxZoom:15,duration:.45});
    render();
  }
  function renderOperations(field) {
    const host=$('operation-list');
    if(!field.operations.length) { host.innerHTML='<div class="empty-state" style="padding:22px 10px">Работы пока не добавлены.</div>'; return; }
    host.innerHTML=[...field.operations].reverse().map(op=>{
      const details=[];
      if(op.type==='seeding' && (op.crop || op.variety || op.product || op.amount)) {
        const cropAndVariety=[op.crop,op.variety].filter(Boolean).join(' · ') || op.product || '';
        details.push([cropAndVariety,op.amount ? `${op.amount} ${op.unit||'кг'}` : ''].filter(Boolean).join(' — '));
      }
      if(op.type==='chemical') {
        const products=Array.isArray(op.products) ? op.products : (op.product || op.amount ? [{name:op.product,amount:op.amount,unit:op.unit}] : []);
        products.forEach(product=>details.push([product.name,product.amount ? `${product.amount} ${product.unit||''}` : ''].filter(Boolean).join(' — ')));
      }
      if(op.date) details.push(new Date(`${op.date}T12:00:00`).toLocaleDateString('ru-RU'));
      if(op.note) details.push(op.note);
      const typeName=op.typeName||({other:'Другая работа',seeding:'Сев',chemical:'Химическая обработка'}[op.type]||'Другая работа');
      return `<div class="operation-item"><div><strong>${escapeHtml(op.kind)}</strong><small class="operation-type-label">Тип: ${escapeHtml(typeName)}</small><small>${escapeHtml(details.join(' · ') || 'Без дополнительных данных')}</small></div><span class="op-chip">${{planned:'План',active:'В работе',done:'Готово'}[op.status]}</span><button type="button" class="remove-op" data-op="${escapeHtml(op.id)}">Удалить</button></div>`;
    }).join('');
    host.querySelectorAll('.remove-op').forEach(button=>button.addEventListener('click',()=>{field.operations=field.operations.filter(o=>o.id!==button.dataset.op);save();renderOperations(field);toast('Операция удалена');}));
  }
  function updateKindOptions() {
    const select=$('operation-kind'), previous=select.value;
    select.innerHTML=state.kinds.map(k=>`<option value="${escapeHtml(k)}">${escapeHtml(k)}</option>`).join('');
    if(state.kinds.includes(previous)) select.value=previous;
  }
  function updateOperationTypeOptions() {
    const select=$('operation-type'), previous=select.value;
    select.innerHTML=state.operationTypes.map(type=>`<option value="${escapeHtml(type.id)}">${escapeHtml(type.name)}</option>`).join('');
    if(state.operationTypes.some(type=>type.id===previous)) select.value=previous;
  }
  function addChemicalRow(values={}) {
    const row=document.createElement('div'); row.className='chemical-product-row';
    row.innerHTML=`<input data-chemical-name maxlength="80" aria-label="Название СЗР" placeholder="Название препарата" value="${escapeHtml(values.name||'')}"><input data-chemical-amount type="number" min="0" step="0.1" aria-label="Количество СЗР" placeholder="Количество" value="${escapeHtml(values.amount||'')}"><select data-chemical-unit aria-label="Единица СЗР"><option value="л">л</option><option value="кг">кг</option><option value="л/га">л/га</option><option value="кг/га">кг/га</option></select><button type="button" class="remove-chemical" aria-label="Удалить препарат">×</button>`;
    $('chemical-product-list').append(row);
    row.querySelector('[data-chemical-unit]').value=values.unit||'л';
    row.querySelector('.remove-chemical').addEventListener('click',()=>row.remove());
  }
  $('kml-input').addEventListener('change', async event => {
    const file=event.target.files?.[0]; if(!file) return;
    try {
      const imported=parseKml(await file.text());
      const existing=new Map(state.fields.map(f=>[f.sourceId,f]));
      const replacement=imported.map(f=>{const prior=existing.get(f.sourceId); return prior ? {...f,name:prior.name,operations:prior.operations,color:prior.color} : f;});
      const retained=state.fields.filter(f=>!imported.some(n=>n.sourceId===f.sourceId));
      state.fields=[...replacement,...retained]; state.importedAt=new Date().toLocaleDateString('ru-RU'); selectedId=null; save(); rebuildMap(); toast(`Импортировано полей: ${imported.length}`);
    } catch(error) { toast(error.message || 'Ошибка при чтении файла'); }
    event.target.value='';
  });
  $('field-search').addEventListener('input',render);
  $('status-filters').addEventListener('click',e=>{const btn=e.target.closest('[data-filter]');if(!btn)return;activeFilter=btn.dataset.filter;document.querySelectorAll('.filter').forEach(x=>x.classList.toggle('active',x===btn));render();});
  $('field-name').addEventListener('input',()=>{const f=state.fields.find(x=>x.id===selectedId);if(!f)return;f.name=$('field-name').value.trim()||f.sourceId; $('dialog-title').textContent=f.name; const layer=layerById.get(f.id);if(layer)layer.setTooltipContent(escapeHtml(f.name)); save();});
  $('done-button').addEventListener('click',()=>{const f=state.fields.find(x=>x.id===selectedId);if(f){f.name=$('field-name').value.trim()||f.sourceId;save();} $('field-dialog').close();});
  $('add-operation').addEventListener('click',()=>{if(!state.kinds.length)state.kinds=[...DEFAULT_KINDS];updateKindOptions();updateOperationTypeOptions();$('operation-form').reset();$('operation-area').value='';$('chemical-product-list').replaceChildren();$('operation-date').value=new Date().toISOString().slice(0,10);$('seed-fields').hidden=true;$('chemical-fields').hidden=true;$('operation-dialog').showModal();});
  $('operation-type').addEventListener('change',()=>{
    const type=$('operation-type').value;
    $('seed-fields').hidden=type!=='seeding'; $('chemical-fields').hidden=type!=='chemical';
    if(type==='chemical' && !$('chemical-product-list').children.length) addChemicalRow();
  });
  $('add-chemical-product').addEventListener('click',()=>addChemicalRow());
  $('operation-form').addEventListener('submit',e=>{
    e.preventDefault(); const field=state.fields.find(x=>x.id===selectedId); if(!field)return;
    const type=$('operation-type').value, kind=$('operation-kind').value||'Работа', area=Number($('operation-area').value);
    if(!Number.isFinite(area)||area<=0){toast('Укажите обработанную площадь в гектарах');$('operation-area').focus();return;}
    const products=type==='chemical'?[...$('chemical-product-list').querySelectorAll('.chemical-product-row')].map(row=>({name:row.querySelector('[data-chemical-name]').value.trim(),amount:row.querySelector('[data-chemical-amount]').value,unit:row.querySelector('[data-chemical-unit]').value})).filter(item=>item.name||item.amount):[];
    const crop=type==='seeding'?$('seed-crop').value.trim():'';
    const variety=type==='seeding'?$('seed-variety').value.trim():'';
    const amount=type==='seeding'?$('seed-amount').value:'';
    const typeName=$('operation-type').selectedOptions[0]?.textContent||'Другая работа';
    if(!state.campaigns.some(item=>item.name.toLocaleLowerCase('ru')===kind.toLocaleLowerCase('ru')))state.campaigns.push({id:uid(),name:kind,planArea:0});
    field.operations.push({id:uid(),kind,type,typeName,status:$('operation-status').value,date:$('operation-date').value,area,shift:$('operation-shift').value,aggregateCount:1,crop,variety,product:type==='seeding'?[crop,variety].filter(Boolean).join(' · '):'',amount,unit:type==='seeding'?'кг':'',products,note:$('operation-note').value.trim()});
    save();renderOperations(field);$('operation-dialog').close();toast('Операция добавлена в сводку');
  });
  $('cancel-operation').addEventListener('click',()=>$('operation-dialog').close());
  $('add-operation-type').addEventListener('click',()=>{$('new-type-name').value='';$('type-dialog').showModal();});
  $('type-form').addEventListener('submit',e=>{
    e.preventDefault(); const name=$('new-type-name').value.trim(); if(!name)return;
    let type=state.operationTypes.find(item=>item.name.toLocaleLowerCase('ru')===name.toLocaleLowerCase('ru'));
    if(!type){type={id:`custom-${uid()}`,name};state.operationTypes.push(type);save();}
    updateOperationTypeOptions();$('operation-type').value=type.id;$('type-dialog').close();
  });
  $('cancel-type').addEventListener('click',()=>$('type-dialog').close());
  $('settings-button').addEventListener('click',()=>{renderKinds();$('kinds-dialog').showModal();});
  function renderKinds(){ $('kind-list').innerHTML=state.kinds.map((kind,index)=>`<div class="kind-row"><span>${escapeHtml(kind)}</span><button type="button" data-kind="${index}" aria-label="Удалить ${escapeHtml(kind)}">Удалить</button></div>`).join(''); $('kind-list').querySelectorAll('button').forEach(b=>b.addEventListener('click',()=>{state.kinds.splice(Number(b.dataset.kind),1);save();renderKinds();})); }
  $('add-kind').addEventListener('click',()=>{renderKinds();$('kinds-dialog').showModal();$('operation-dialog').close();});
  $('save-kind').addEventListener('click',()=>{const input=$('new-kind-name'),name=input.value.trim();if(!name)return;if(!state.kinds.some(k=>k.toLowerCase()===name.toLowerCase()))state.kinds.push(name);input.value='';save();renderKinds();updateKindOptions();toast('Вид операции добавлен');});
  $('auth-form').addEventListener('submit', async event => {
    event.preventDefault();
    if(!supabaseClient){setAuthMessage('Подключение к общей базе не настроено. Обновите страницу или сообщите владельцу сайта.');return;}
    setAuthMessage('Выполняется вход…');
    const {error}=await supabaseClient.auth.signInWithPassword({email:$('auth-email').value.trim(),password:$('auth-password').value});
    if(error)setAuthMessage(authError(error));
  });
  $('signup-button').addEventListener('click', async()=>{
    if(!supabaseClient){setAuthMessage('Подключение к общей базе не настроено.');return;}
    const email=$('auth-email').value.trim(),password=$('auth-password').value;
    if(!email||password.length<6){setAuthMessage('Введите электронную почту и пароль не короче 6 символов.');return;}
    setAuthMessage('Создаём аккаунт…');
    const redirect=new URL(location.href); const pendingInvite=new URLSearchParams(location.search).get('invite'); if(pendingInvite)redirect.searchParams.set('invite',pendingInvite);
    const {data,error}=await supabaseClient.auth.signUp({email,password,options:{emailRedirectTo:redirect.toString()}});
    if(error){setAuthMessage(authError(error));return;}
    if(!data.session)setAuthMessage('Аккаунт создан. Подтвердите адрес по ссылке из письма, затем войдите сюда.');
  });
  $('farm-setup-form').addEventListener('submit',async event=>{
    event.preventDefault(); if(!supabaseClient||!currentSession)return;
    const {data,error}=await supabaseClient.rpc('create_field_ops_farm',{p_name:$('farm-name').value.trim()});
    if(error){$('farm-message').textContent=authError(error);return;}
    await openFarm(data);
  });
  $('logout-button').addEventListener('click',()=>supabaseClient?.auth.signOut());
  $('report-button').addEventListener('click',()=>openReport());
  $('close-report').addEventListener('click',()=>$('report-dialog').close());
  $('report-date').addEventListener('change',renderReport);
  $('export-summary').addEventListener('click',exportSummaryImage);
  document.querySelectorAll('.report-tab').forEach(button=>button.addEventListener('click',()=>{document.querySelectorAll('.report-tab').forEach(tab=>tab.classList.toggle('active',tab===button));$('summary-view').hidden=button.dataset.tab!=='summary';$('journal-view').hidden=button.dataset.tab!=='journal';renderReport();}));
  $('campaign-form').addEventListener('submit',event=>{event.preventDefault();const name=$('campaign-name').value.trim(),planArea=Number($('campaign-plan').value);if(!name||!Number.isFinite(planArea))return;const found=state.campaigns.find(item=>item.name.toLocaleLowerCase('ru')===name.toLocaleLowerCase('ru'));if(found)found.planArea=planArea;else state.campaigns.push({id:uid(),name,planArea});if(!state.kinds.some(kind=>kind.toLocaleLowerCase('ru')===name.toLocaleLowerCase('ru')))state.kinds.push(name);$('campaign-form').reset();save();updateKindOptions();renderReport();toast('План работы сохранён');});
  $('add-shift-field').addEventListener('click',()=>addShiftFieldRow());
  $('shift-form').addEventListener('submit',event=>{event.preventDefault();const campaignId=$('shift-campaign').value,campaign=state.campaigns.find(item=>item.id===campaignId),workDate=$('report-date').value,shift=$('shift-kind').value;if(!campaign||!workDate)return;const inputs=[...$('shift-fields').querySelectorAll('.shift-field-row')],fields=inputs.map(row=>({fieldId:row.querySelector('select').value,fieldName:state.fields.find(f=>f.id===row.querySelector('select').value)?.name||'',area:Number(row.querySelector('input').value)||0})).filter(row=>row.fieldId&&row.area>0);if(!fields.length){toast('Добавьте поле и гектары');return;}let log=state.shiftLogs.find(item=>item.workDate===workDate&&item.campaignId===campaignId&&item.shift===shift);if(!log){log={id:uid(),workDate,shift,campaignId,aggregateCount:0,fields:[]};state.shiftLogs.push(log);}log.aggregateCount=Number($('shift-aggregates').value)||0;for(const row of fields){const prev=log.fields.find(item=>item.fieldId===row.fieldId);if(prev)prev.area+=row.area;else log.fields.push(row);} $('shift-form').reset();$('shift-fields').innerHTML='';addShiftFieldRow();save();renderReport();toast('Сменная запись добавлена в журнал');});
  $('rain-form').addEventListener('submit',event=>{event.preventDefault();const workDate=$('report-date').value,settlement=$('rain-settlement').value.trim(),amountMm=Number($('rain-amount').value);if(!workDate||!settlement||!Number.isFinite(amountMm))return;let row=state.rainfallLogs.find(item=>item.workDate===workDate&&item.settlement.toLocaleLowerCase('ru')===settlement.toLocaleLowerCase('ru'));if(row)row.amountMm=amountMm;else state.rainfallLogs.push({id:uid(),workDate,settlement,amountMm});$('rain-form').reset();save();renderReport();toast('Осадки сохранены');});
  $('collab-button').addEventListener('click',()=>{$('account-email').textContent=currentSession?.user?.email||'';$('invite-result').hidden=true;$('collab-dialog').showModal();});
  $('create-invite').addEventListener('click',async()=>{
    if(!currentFarmId)return;
    const token=uid();
    const {error}=await supabaseClient.rpc('create_field_ops_invite',{p_farm_id:currentFarmId,p_token:token,p_role:$('invite-role').value});
    if(error){toast(authError(error));return;}
    const link=new URL(location.href); link.searchParams.set('invite',token);
    $('invite-link').value=link.toString(); $('invite-result').hidden=false;
  });
  $('copy-invite').addEventListener('click',async()=>{try{await navigator.clipboard.writeText($('invite-link').value);toast('Ссылка скопирована');}catch{ $('invite-link').select(); document.execCommand('copy'); toast('Ссылка скопирована'); }});
  rebuildMap(); render();
  void initializeSharedApp();

  function productionDateDefault(){const d=new Date();d.setDate(d.getDate()-1);return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;}
  function openReport(){$('report-date').value=productionDateDefault();$('report-dialog').showModal();renderReport();}
  function exportSummaryImage(){
    const content=$('summary-content');
    const reportDate=$('report-date').value;
    if(!content||!reportDate){toast('Выберите дату сводки');return;}
    const [year,month,day]=reportDate.split('-');
    const dateLabel=`${day}.${month}.${year}`;
    const farmName=$('farm-caption')?.textContent?.trim()||'Сводка работ';
    const campaignBlocks=[...content.querySelectorAll('.report-block:not(.rain-block)')];
    const rainBlock=content.querySelector('.rain-block');
    const rainRows=rainBlock?[...rainBlock.querySelectorAll('.rain-row')]:[];
    const width=1100, margin=22, rowHeight=38;
    const height=74+campaignBlocks.length*(42+rowHeight*4+34+14)+(rainBlock?42+38+rainRows.length*36+18:0);
    const canvas=document.createElement('canvas');
    canvas.width=width*2;canvas.height=height*2;
    const ctx=canvas.getContext('2d');
    if(!ctx){toast('Не удалось подготовить изображение');return;}
    ctx.scale(2,2);ctx.fillStyle='#fff';ctx.fillRect(0,0,width,height);
    const line=(y,x1=margin,x2=width-margin)=>{ctx.strokeStyle='#222';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(x1,y);ctx.lineTo(x2,y);ctx.stroke();};
    const cellText=(text,x,y,align='left',font='bold 18px "Times New Roman",serif')=>{ctx.fillStyle='#111';ctx.font=font;ctx.textAlign=align;ctx.textBaseline='middle';ctx.fillText(String(text||''),x,y);};
    const header=(title,y,h=42)=>{ctx.fillStyle='#c9dcef';ctx.fillRect(margin,y,width-margin*2,h);ctx.strokeStyle='#222';ctx.strokeRect(margin,y,width-margin*2,h);cellText(title,width/2,y+h/2,'center','bold 20px "Times New Roman",serif');};
    header(`${farmName} — ${dateLabel}`,0,34);
    let y=44;
    campaignBlocks.forEach(block=>{
      const title=block.querySelector(':scope > h3')?.textContent||'Работы';
      header(title,y,42);y+=42;
      const rows=[...block.querySelectorAll(':scope > div:not(.rain-head):not(.rain-row)')];
      rows.forEach(row=>{
        const label=row.querySelector('b')?.textContent||'';
        let value=row.querySelector('span')?.innerText?.replace(/\s+/g,' ').trim()||'';
        const pctMatch=value.match(/\s+([\d.,]+%)$/);
        const pct=pctMatch?.[1]||'';
        if(pct)value=value.slice(0,-pctMatch[0].length).trim();
        ctx.fillStyle='#fff';ctx.fillRect(margin,y,width-margin*2,rowHeight);
        line(y+rowHeight,margin,width-margin);
        cellText(label,margin+10,y+rowHeight/2);
        cellText(value,width-145,y+rowHeight/2,'right');
        if(pct)cellText(pct,width-margin-10,y+rowHeight/2,'right');
        y+=rowHeight;
      });
      const aggregates=block.querySelector(':scope > small')?.textContent||'';
      ctx.fillStyle='#fff';ctx.fillRect(margin,y,width-margin*2,34);line(y,margin,width-margin);line(y+34,margin,width-margin);
      cellText(aggregates,margin+10,y+17);y+=48;
    });
    if(rainBlock){
      header(rainBlock.querySelector(':scope > h3')?.textContent||'Осадки в виде дождя, мм',y,42);y+=42;
      const headers=[...rainBlock.querySelectorAll('.rain-head b')].map(el=>el.textContent);
      const widths=[width*.46,width*.27,width*.27], starts=[margin,margin+width*.46,margin+width*.73];
      ctx.fillStyle='#dce7f1';ctx.fillRect(margin,y,width-margin*2,38);
      headers.forEach((label,i)=>{ctx.strokeStyle='#222';ctx.strokeRect(starts[i],y,widths[i],38);cellText(label,starts[i]+widths[i]/2,y+19,'center','bold 16px "Times New Roman",serif');});
      y+=38;
      rainRows.forEach(row=>{
        const values=[...row.children].map(el=>el.textContent.trim());
        values.forEach((value,i)=>{ctx.strokeStyle='#222';ctx.strokeRect(starts[i],y,widths[i],36);cellText(value,starts[i]+widths[i]/2,y+18,'center','bold 16px "Times New Roman",serif');});
        y+=36;
      });
    }
    canvas.toBlob(blob=>{
      if(!blob){toast('Не удалось создать PNG');return;}
      const url=URL.createObjectURL(blob),link=document.createElement('a');
      link.href=url;link.download=`сводка-${reportDate}.png`;link.click();
      setTimeout(()=>URL.revokeObjectURL(url),1000);
      toast('Сводка сохранена как PNG');
    },'image/png');
  }
  function addShiftFieldRow(){const row=document.createElement('div');row.className='shift-field-row';row.innerHTML=`<select aria-label="Поле"><option value="">Выберите поле</option>${state.fields.map(field=>`<option value="${escapeHtml(field.id)}">${escapeHtml(field.name)} · ${Number(field.area||0).toFixed(1)} га</option>`).join('')}</select><input type="number" min="0.1" step="0.1" placeholder="га" aria-label="Гектары"><button type="button" aria-label="Убрать поле">×</button>`;row.querySelector('button').addEventListener('click',()=>row.remove());$('shift-fields').append(row);}
  function renderReport(){if(!$('report-date').value)return;const date=$('report-date').value,year=date.slice(0,4),today=state.shiftLogs.filter(log=>log.workDate===date),campaigns=state.campaigns;
    $('shift-campaign').innerHTML=campaigns.length?campaigns.map(c=>`<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}</option>`).join(''):'<option value="">Сначала добавьте план</option>';
    if(!$('shift-fields').children.length)addShiftFieldRow();
    const filter=$('summary-operation-filter'),previous=filter.value;filter.innerHTML='<option value="all">Все операции</option>'+campaigns.map(c=>`<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}</option>`).join('');if([...filter.options].some(option=>option.value===previous))filter.value=previous;
    const rainToday=state.rainfallLogs.filter(row=>row.workDate===date);const rainYear=state.rainfallLogs.filter(row=>row.workDate.slice(0,4)===year&&row.workDate<=date);const settlements=[...new Set([...rainToday,...rainYear].map(row=>row.settlement))].sort((a,b)=>a.localeCompare(b,'ru'));
    const selectedCampaignId=filter.value, visibleCampaigns=selectedCampaignId==='all'?campaigns:campaigns.filter(c=>c.id===selectedCampaignId);
    $('summary-content').innerHTML=visibleCampaigns.map(c=>{const matches=op=>String(op.kind||'').toLocaleLowerCase('ru')===c.name.toLocaleLowerCase('ru'),fieldOps=state.fields.flatMap(field=>(field.operations||[]).filter(op=>matches(op)&&op.date<=date).map(op=>({op,field}))),todayOps=fieldOps.filter(item=>item.op.date===date),entries=state.shiftLogs.filter(log=>log.campaignId===c.id&&log.workDate<=date),todayLegacy=today.filter(log=>log.campaignId===c.id),todayArea=todayLegacy.reduce((sum,log)=>sum+log.fields.reduce((n,f)=>n+(Number(f.area)||0),0),0)+todayOps.reduce((n,item)=>n+(Number(item.op.area)||0),0),total=entries.reduce((sum,log)=>sum+log.fields.reduce((n,f)=>n+(Number(f.area)||0),0),0)+fieldOps.reduce((n,item)=>n+(Number(item.op.area)||0),0),remaining=Math.max(0,(Number(c.planArea)||0)-total),aggregates=Math.max(0,...todayLegacy.map(log=>Number(log.aggregateCount)||0),...todayOps.map(item=>Number(item.op.aggregateCount)||0)),pct=c.planArea?total/Number(c.planArea)*100:0;return `<div class="report-block"><h3>${escapeHtml(c.name)}</h3><div><b>План, га</b><span>${fmt(c.planArea)} <i>100%</i></span></div><div><b>За сутки, га</b><span>${fmt(todayArea)}</span></div><div><b>Всего, га</b><span>${fmt(total)} <i>${fmt(pct)}%</i></span></div><div><b>Остаток, га</b><span>${fmt(remaining)} <i>${fmt(c.planArea?remaining/Number(c.planArea)*100:0)}%</i></span></div><small>Работало ${aggregates} агрегат${plural(aggregates)}</small></div>`;}).join('')||'<p class="report-empty">Добавьте план работы, чтобы сформировать сводку.</p>';
    $('summary-content').insertAdjacentHTML('beforeend',`<div class="report-block rain-block"><h3>Осадки в виде дождя, мм</h3><div class="rain-head"><b>Населённый пункт</b><b>За сутки на утро</b><b>Всего с начала года</b></div>${settlements.map(name=>`<div class="rain-row"><b>${escapeHtml(name)}</b><span>${fmt(rainToday.filter(r=>r.settlement===name).reduce((n,r)=>n+Number(r.amountMm||0),0))}</span><span>${fmt(rainYear.filter(r=>r.settlement===name).reduce((n,r)=>n+Number(r.amountMm||0),0))}</span></div>`).join('')}</div>`);
    const shiftName=shift=>shift==='day'?'Дневная · 07:00–17:00':'Ночная · 18:00–06:59';const logs=today.slice().sort((a,b)=>(a.shift==='day'?-1:1));const logRows=logs.flatMap(log=>log.fields.map(f=>`<tr><td>${shiftName(log.shift)}</td><td>${escapeHtml(campaigns.find(c=>c.id===log.campaignId)?.name||'')}</td><td>${escapeHtml(f.fieldName||state.fields.find(x=>x.id===f.fieldId)?.name||'')}</td><td>${fmt(f.area)} га</td><td>${Number(log.aggregateCount)||0}</td></tr>`));const operationRows=state.fields.flatMap(field=>(field.operations||[]).filter(op=>op.date===date).map(op=>{const detail=[op.area?fmt(op.area)+' га':'',op.crop,op.variety,op.products?.map(p=>[p.name,p.amount,p.unit].filter(Boolean).join(' ')).join(', '),op.note].filter(Boolean).join(' · ');return `<tr><td>${shiftName(op.shift)}</td><td>${escapeHtml(op.kind||'')}</td><td>${escapeHtml(field.name)}</td><td>${escapeHtml(detail||'—')}</td><td>${Number(op.aggregateCount)||1}</td></tr>`;}));const rainRows=rainToday.map(r=>`<tr><td>Осадки</td><td>—</td><td>${escapeHtml(r.settlement)}</td><td>${fmt(r.amountMm)} мм</td><td>—</td></tr>`);
    $('journal-view').innerHTML=`<h3>Работы за ${escapeHtml(date)}</h3><div class="journal-table-wrap"><table class="journal-table"><thead><tr><th>Смена</th><th>Работа</th><th>Поле</th><th>Выполнено / сведения</th><th>Агрегаты</th></tr></thead><tbody>${logRows.concat(operationRows,rainRows).join('')||'<tr><td colspan="5">Записей за этот день пока нет.</td></tr>'}</tbody></table></div>`;
  }
  function fmt(value){return (Number(value)||0).toLocaleString('ru-RU',{maximumFractionDigits:1});}
  function plural(n){return n%10===1&&n%100!==11?'':'ов';}

  function setAuthMessage(message){$('auth-message').textContent=message;}
  function authError(error){return String(error?.message||'Не удалось выполнить действие.').replace(/\s+/g,' ').slice(0,240);}
  async function initializeSharedApp(){
    const config=window.SUPABASE_CONFIG||{},url=String(config.url||'').trim(),key=String(config.publishableKey||config.anonKey||'').trim();
    if(!url||!key||!window.supabase?.createClient){setAuthMessage('Не удалось подключиться к Supabase. Проверьте настройки и интернет.');return;}
    supabaseClient=window.supabase.createClient(url,key,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
    supabaseClient.auth.onAuthStateChange((_event,session)=>{window.setTimeout(()=>{void handleSession(session);},0);});
    const {data,error}=await supabaseClient.auth.getSession();
    if(error){setAuthMessage(authError(error));return;}
    if(data.session)await handleSession(data.session);
  }
  async function handleSession(session){
    if(authBusy)return;
    if(!session){
      const signedOut=Boolean(currentSession);
      currentSession=null;currentFarmId=null;$('app-shell').hidden=true;$('auth-gate').hidden=false;$('auth-form').hidden=false;$('farm-setup-form').hidden=true;
      if(signedOut){state={fields:[],kinds:[...DEFAULT_KINDS],operationTypes:[...DEFAULT_TYPES],importedAt:'',campaigns:[],shiftLogs:[],rainfallLogs:[]};rebuildMap();render();}
      return;
    }
    if(currentFarmId&&currentSession?.user?.id===session.user.id)return;
    authBusy=true; currentSession=session;
    try{
      const inviteToken=new URLSearchParams(location.search).get('invite');let invitedFarmId=null;
      if(inviteToken){
        const {data,error}=await supabaseClient.rpc('redeem_field_ops_invite',{p_token:inviteToken});
        if(error)toast(authError(error));
        else invitedFarmId=data;
        const nextUrl=new URL(location.href);nextUrl.searchParams.delete('invite');history.replaceState({},'',nextUrl.toString());
      }
      const {data:farms,error}=await supabaseClient.from('farms').select('id,name').order('name');
      if(error)throw error;
      if(!farms?.length){$('auth-form').hidden=true;$('farm-setup-form').hidden=false;setAuthMessage('');return;}
      const selectedFarm=farms.find(farm=>farm.id===invitedFarmId)||farms[0];
      await openFarm(selectedFarm.id,selectedFarm.name);
    }catch(error){currentFarmId=null;setAuthMessage(`Не удалось открыть общее хозяйство: ${authError(error)}. Установите миграцию базы данных.`);}
    finally{authBusy=false;}
  }
  async function openFarm(farmId,farmName=''){
    currentFarmId=farmId;
    const [{data:rows,error:fieldsError},{data:settingsRow,error:settingsError},{data:campaignRows,error:campaignError},{data:shiftRows,error:shiftError},{data:rainRows,error:rainError}]=await Promise.all([
      supabaseClient.from('field_ops_fields').select('id,source_id,name,geometry,area,operations,color').eq('farm_id',farmId),
      supabaseClient.from('field_ops_settings').select('kinds,operation_types,imported_at').eq('farm_id',farmId).maybeSingle(),
      supabaseClient.from('field_ops_campaigns').select('id,name,plan_area').eq('farm_id',farmId),
      supabaseClient.from('field_ops_shift_logs').select('id,work_date,shift,campaign_id,aggregate_count,field_entries').eq('farm_id',farmId),
      supabaseClient.from('field_ops_rainfall').select('id,work_date,settlement,amount_mm').eq('farm_id',farmId)
    ]);
    if(fieldsError)throw fieldsError;if(settingsError)throw settingsError;if(campaignError)throw campaignError;if(shiftError)throw shiftError;if(rainError)throw rainError;
    const local=hasMigratedLocalData?{fields:[],kinds:[...DEFAULT_KINDS],operationTypes:[...DEFAULT_TYPES],importedAt:''}:state;
    state=local;
    if(rows?.length){
      const cloud=rows.map(row=>({...row,sourceId:row.source_id,area:Number(row.area)||0,operations:Array.isArray(row.operations)?row.operations:[]}));
      const known=new Set(cloud.map(field=>field.id));
      state.fields=[...cloud,...local.fields.filter(field=>!known.has(field.id))];
    }else if(local.fields.length){state.fields=local.fields;}
    if(settingsRow){state.kinds=settingsRow.kinds||[...DEFAULT_KINDS];state.operationTypes=settingsRow.operation_types||[...DEFAULT_TYPES];state.importedAt=settingsRow.imported_at||'';}
    state.campaigns=campaignRows.map(row=>({id:row.id,name:row.name,planArea:Number(row.plan_area)||0}));state.shiftLogs=shiftRows.map(row=>({id:row.id,workDate:row.work_date,shift:row.shift,campaignId:row.campaign_id,aggregateCount:Number(row.aggregate_count)||0,fields:Array.isArray(row.field_entries)?row.field_entries:[]}));state.rainfallLogs=rainRows.map(row=>({id:row.id,workDate:row.work_date,settlement:row.settlement,amountMm:Number(row.amount_mm)||0}));
    currentFarmId=farmId;
    if(!rows?.length||state.fields.some(field=>!(rows||[]).some(row=>row.id===field.id))){
      const saved=await saveCloudState();
      if(!saved)throw new Error('Не удалось сохранить данные в общей базе. Локальная копия сохранена.');
    }
    hasMigratedLocalData=true;localStorage.setItem('field-operations-cloud-migrated-v1','true');
    localStorage.setItem(STORAGE_KEY,JSON.stringify(state));
    $('farm-caption').textContent=farmName||'Общие данные хозяйства';
    $('account-email').textContent=currentSession?.user?.email||'';
    $('auth-gate').hidden=true;$('app-shell').hidden=false;
    rebuildMap();render();map.invalidateSize();subscribeToFarm();
    toast('Данные синхронизируются через общую базу');
  }
  async function saveCloudState(){
    if(!supabaseClient||!currentSession||!currentFarmId)return;
    const fields=state.fields.map(field=>({id:field.id,farm_id:currentFarmId,source_id:field.sourceId||'',name:field.name||'Поле',geometry:field.geometry,area:Number(field.area)||0,operations:field.operations||[],color:field.color||null,updated_at:new Date().toISOString(),updated_by:currentSession.user.id,device_id:deviceId}));
    for(let i=0;i<fields.length;i+=100){const {error}=await supabaseClient.from('field_ops_fields').upsert(fields.slice(i,i+100),{onConflict:'id'});if(error){toast(`Ошибка синхронизации: ${authError(error)}`);return false;}}
    const {error}=await supabaseClient.from('field_ops_settings').upsert({farm_id:currentFarmId,kinds:state.kinds,operation_types:state.operationTypes,imported_at:state.importedAt||'',updated_at:new Date().toISOString(),updated_by:currentSession.user.id,device_id:deviceId},{onConflict:'farm_id'});
    if(error){toast(`Ошибка синхронизации: ${authError(error)}`);return false;}
    const metadata={farm_id:currentFarmId,updated_at:new Date().toISOString(),updated_by:currentSession.user.id,device_id:deviceId};
    const campaigns=state.campaigns.map(c=>({...metadata,id:c.id,name:c.name,plan_area:Number(c.planArea)||0}));
    const shifts=state.shiftLogs.map(log=>({...metadata,id:log.id,work_date:log.workDate,shift:log.shift,campaign_id:log.campaignId,aggregate_count:Number(log.aggregateCount)||0,field_entries:log.fields||[]}));
    const rain=state.rainfallLogs.map(log=>({...metadata,id:log.id,work_date:log.workDate,settlement:log.settlement,amount_mm:Number(log.amountMm)||0}));
    for(const [table,rows] of [['field_ops_campaigns',campaigns],['field_ops_shift_logs',shifts],['field_ops_rainfall',rain]])if(rows.length){const {error:syncError}=await supabaseClient.from(table).upsert(rows,{onConflict:'id'});if(syncError){toast(`Ошибка синхронизации журнала: ${authError(syncError)}`);return false;}}
    return true;
  }
  function subscribeToFarm(){
    if(realtimeChannel)supabaseClient.removeChannel(realtimeChannel);
    realtimeChannel=supabaseClient.channel(`field-ops-${currentFarmId}`)
      .on('postgres_changes',{event:'*',schema:'public',table:'field_ops_fields',filter:`farm_id=eq.${currentFarmId}`},event=>{
        if(event.new?.device_id===deviceId)return;
        void refreshCloudState();
      })
      .on('postgres_changes',{event:'*',schema:'public',table:'field_ops_settings',filter:`farm_id=eq.${currentFarmId}`},event=>{
        if(event.new?.device_id===deviceId)return;
        void refreshCloudState();
      })
      .on('postgres_changes',{event:'*',schema:'public',table:'field_ops_campaigns',filter:`farm_id=eq.${currentFarmId}`},()=>void refreshCloudState())
      .on('postgres_changes',{event:'*',schema:'public',table:'field_ops_shift_logs',filter:`farm_id=eq.${currentFarmId}`},()=>void refreshCloudState())
      .on('postgres_changes',{event:'*',schema:'public',table:'field_ops_rainfall',filter:`farm_id=eq.${currentFarmId}`},()=>void refreshCloudState()).subscribe();
  }
  async function refreshCloudState(){
    if(!currentFarmId)return;
    const [{data:rows},{data:settings},{data:campaignRows},{data:shiftRows},{data:rainRows}]=await Promise.all([
      supabaseClient.from('field_ops_fields').select('id,source_id,name,geometry,area,operations,color').eq('farm_id',currentFarmId),
      supabaseClient.from('field_ops_settings').select('kinds,operation_types,imported_at').eq('farm_id',currentFarmId).maybeSingle(),
      supabaseClient.from('field_ops_campaigns').select('id,name,plan_area').eq('farm_id',currentFarmId),
      supabaseClient.from('field_ops_shift_logs').select('id,work_date,shift,campaign_id,aggregate_count,field_entries').eq('farm_id',currentFarmId),
      supabaseClient.from('field_ops_rainfall').select('id,work_date,settlement,amount_mm').eq('farm_id',currentFarmId)
    ]);
    if(!rows)return;
    state.fields=rows.map(row=>({...row,sourceId:row.source_id,area:Number(row.area)||0,operations:Array.isArray(row.operations)?row.operations:[]}));
    if(settings){state.kinds=settings.kinds||[...DEFAULT_KINDS];state.operationTypes=settings.operation_types||[...DEFAULT_TYPES];state.importedAt=settings.imported_at||'';}
    state.campaigns=(campaignRows||[]).map(row=>({id:row.id,name:row.name,planArea:Number(row.plan_area)||0}));state.shiftLogs=(shiftRows||[]).map(row=>({id:row.id,workDate:row.work_date,shift:row.shift,campaignId:row.campaign_id,aggregateCount:Number(row.aggregate_count)||0,fields:Array.isArray(row.field_entries)?row.field_entries:[]}));state.rainfallLogs=(rainRows||[]).map(row=>({id:row.id,workDate:row.work_date,settlement:row.settlement,amountMm:Number(row.amount_mm)||0}));
    localStorage.setItem(STORAGE_KEY,JSON.stringify(state));rebuildMap();render();
  }
})();

