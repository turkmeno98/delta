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
  const layerById = new Map();
  if (L.Control.Draw) {
    new L.Control.Draw({ position: 'topleft', draw: false, edit: { featureGroup: editableFields, remove: false } }).addTo(map);
  }

  function loadState() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      const customTypes=Array.isArray(raw.operationTypes) ? raw.operationTypes.filter(type=>type?.id&&!DEFAULT_TYPES.some(base=>base.id===type.id)) : [];
      return { fields: Array.isArray(raw.fields) ? raw.fields : [], kinds: Array.isArray(raw.kinds) ? raw.kinds : [...DEFAULT_KINDS], operationTypes:[...DEFAULT_TYPES,...customTypes], importedAt: raw.importedAt || '' };
    } catch { return { fields: [], kinds: [...DEFAULT_KINDS], operationTypes:[...DEFAULT_TYPES], importedAt: '' }; }
  }
  function save() { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); render(); }
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
  $('add-operation').addEventListener('click',()=>{if(!state.kinds.length)state.kinds=[...DEFAULT_KINDS];updateKindOptions();updateOperationTypeOptions();$('operation-form').reset();$('chemical-product-list').replaceChildren();$('operation-date').value=new Date().toISOString().slice(0,10);$('seed-fields').hidden=true;$('chemical-fields').hidden=true;$('operation-dialog').showModal();});
  $('operation-type').addEventListener('change',()=>{
    const type=$('operation-type').value;
    $('seed-fields').hidden=type!=='seeding'; $('chemical-fields').hidden=type!=='chemical';
    if(type==='chemical' && !$('chemical-product-list').children.length) addChemicalRow();
  });
  $('add-chemical-product').addEventListener('click',()=>addChemicalRow());
  $('operation-form').addEventListener('submit',e=>{
    e.preventDefault(); const field=state.fields.find(x=>x.id===selectedId); if(!field)return;
    const type=$('operation-type').value;
    const products=type==='chemical'?[...$('chemical-product-list').querySelectorAll('.chemical-product-row')].map(row=>({name:row.querySelector('[data-chemical-name]').value.trim(),amount:row.querySelector('[data-chemical-amount]').value,unit:row.querySelector('[data-chemical-unit]').value})).filter(item=>item.name||item.amount):[];
    const crop=type==='seeding'?$('seed-crop').value.trim():'';
    const variety=type==='seeding'?$('seed-variety').value.trim():'';
    const amount=type==='seeding'?$('seed-amount').value:'';
    const typeName=$('operation-type').selectedOptions[0]?.textContent||'Другая работа';
    field.operations.push({id:uid(),kind:$('operation-kind').value||'Работа',type,typeName,status:$('operation-status').value,date:$('operation-date').value,crop,variety,product:type==='seeding'?[crop,variety].filter(Boolean).join(' · '):'',amount,unit:type==='seeding'?'кг':'',products,note:$('operation-note').value.trim()});
    save();renderOperations(field);$('operation-dialog').close();toast('Операция добавлена');
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
  rebuildMap(); render();
})();

