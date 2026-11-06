# Chart licensing

Where Stratos gets its charts, what each publisher's terms allow, and what the
application will and will not do with them. Generated from
`app/js/data/chart-sources.js` by `scripts/chart-licensing-report.mjs`; edit the
registry, then regenerate, rather than editing this file.

## The rule

A public web page is not a redistribution licence. Stratos embeds a document only
when the publisher's terms allow third-party display (today: the U.S. FAA, whose
terminal procedures are a U.S. Government work in the public domain). For every
other publisher the EFB shows the airport's coverage status and a link to the
authority's own portal. Nothing is scraped, framed, proxied or re-hosted.

## Categories

| Category | Meaning | Publishers |
| --- | --- | --- |
| FREE_REUSE | Explicit terms allow third-party display and redistribution. | 1 |
| FREE_PUBLIC | Free public access. Reuse terms still need to be established. | 13 |
| FREE_PERSONAL_ONLY | Free for personal use; not authorised for a Stratos integration. | 0 |
| PAID | Requires a purchase or a commercial licence. | 1 |
| PERMISSION_REQUIRED | The authority must be asked before the documents can be reused. | 7 |
| UNKNOWN | The licence position has not been established. | 62 |

**84 national publishers and 2 regional indexes across 84 countries.**

## Embedded today

| Country | Authority | Publisher | Charts | Terms | Last checked |
| --- | --- | --- | --- | --- | --- |
| United States | Federal Aviation Administration | [FAA Digital Terminal Procedures](https://www.faa.gov/air_traffic/flight_info/aeronav/digital_products/) | diagram, sid, star, approach, minimums, hotspot, enroute, area, vfr, obstacle, visual, parking | Explicit terms allow third-party display and redistribution. | 2026-11-06 |

## Link-only, free to view

Free public access to the charts; reuse terms are not established, so the EFB
links to the publisher and never embeds the document.

| Country | Authority | Publisher | Licence | Last checked |
| --- | --- | --- | --- | --- |
| Australia | Airservices Australia | [Airservices Australia — AIP](https://www.airservicesaustralia.com/aip/aip.asp) | FREE_PUBLIC | not recorded |
| Brazil | DECEA | [DECEA AISWEB — AIP Brazil](https://ais.decea.mil.br/) | FREE_PUBLIC | not recorded |
| France | Service de l’information aéronautique | [SIA — AIP France](https://www.sia.aviation-civile.gouv.fr/?___store=english) | FREE_PUBLIC | not recorded |
| Hong Kong | Civil Aviation Department | [CAD Hong Kong — AIP](https://www.cad.gov.hk/english/publications.html) | FREE_PUBLIC | not recorded |
| India | Airports Authority of India | [AAI — AIP India](https://www.aai.aero/) | FREE_PUBLIC | not recorded |
| Ireland | AirNav Ireland | [AirNav Ireland — AIP Ireland](https://www.airnav.ie/air-traffic-management/aeronautical-information-management) | FREE_PUBLIC | not recorded |
| Japan | Japan Civil Aviation Bureau | [AIS Japan](https://aisjapan.mlit.go.jp/) | FREE_PUBLIC | not recorded |
| New Zealand | Airways New Zealand | [Airways — AIP New Zealand](https://www.airways.co.nz/) | FREE_PUBLIC | not recorded |
| South Africa | South African Civil Aviation Authority | [SACAA — AIP South Africa](https://www.caa.co.za/) | FREE_PUBLIC | not recorded |
| Spain | ENAIRE | [ENAIRE — AIP Spain](https://aip.enaire.es/aip/aip-en.html) | FREE_PUBLIC | not recorded |
| Sweden | LFV | [LFV AIS — Sweden](https://lfv.se/en/services/information-services/aeronautical-information) | FREE_PUBLIC | not recorded |
| United Arab Emirates | General Civil Aviation Authority | [GCAA — AIS United Arab Emirates](https://www.gcaa.gov.ae/en/ais) | FREE_PUBLIC | not recorded |
| United Kingdom | NATS | [NATS AIS — AIP United Kingdom](https://nats-uk.ead-it.com/cms-nats/opencms/en/Publications/AIP/) | FREE_PUBLIC | not recorded |

## Paid or permission required

Stratos cannot embed these charts. The country still resolves to its publisher,
so a pilot always sees who owns the documents and where to ask.

| Country | Authority | Publisher | Licence | Reason |
| --- | --- | --- | --- | --- |
| Austria | Austro Control | [Austro Control — AIP Austria](https://eaip.austrocontrol.at/) | PERMISSION_REQUIRED | Copyright Austro Control; commercial reproduction needs written consent. |
| Canada | NAV CANADA | [NAV CANADA — AIP Canada](https://www.navcanada.ca/en/aeronautical-information/aip-canada.aspx) | PAID | CAP and IFR charts are licensed by NAV CANADA; Stratos does not mirror them. |
| Germany | DFS Deutsche Flugsicherung | [DFS AIS — AIP Germany](https://ais.dfs.de/pilotservice/briefing/aip_online/aip_online.jsp) | PERMISSION_REQUIRED | Free AIP access. The charts are copyright DFS and reuse needs written approval. |
| Italy | ENAV | [ENAV — AIP Italy](https://www.enav.it/en/login-required) | PERMISSION_REQUIRED | Registration required for the online service. |
| Netherlands | LVNL | [LVNL — eAIP Netherlands](https://eaip.lvnl.nl/web/eaip/default.html) | PERMISSION_REQUIRED | Reproduction needs LVNL written permission. |
| Norway | Avinor | [Avinor — AIP Norway](https://partner.avinor.no/en/ais/aip/) | PERMISSION_REQUIRED | AIP Norway is copyright Avinor; use outside copyright law needs permission. |
| Poland | PANSA | [PANSA AIS — AIP Poland](https://www.ais.pansa.pl/) | PERMISSION_REQUIRED | Reproduction and redistribution need PANSA written permission. |
| Switzerland | Skyguide | [Skyguide — Aeronautical information](https://www.skyguide.ch/services/aeronautical-information-management) | PERMISSION_REQUIRED | Registration required; charts are published by Skyguide. |

## Registered, terms not yet verified

The authority is known and linked; the licence position has not been established.
The EFB labels these airports exactly that way rather than guessing.

| Country | Authority | Publisher | Region |
| --- | --- | --- | --- |
| Argentina | Administración Nacional de Aviación Civil | [ANAC — AIP Argentina](https://www.argentina.gob.ar/anac) | South America |
| Bahrain | Ministry of Transportation and Telecommunications | [MTT — AIP Bahrain](https://www.mtt.gov.bh/) | Middle East |
| Bangladesh | Civil Aviation Authority of Bangladesh | [CAAB — AIP Bangladesh](https://www.caab.gov.bd/) | Asia |
| Belgium | skeyes | [skeyes — Aeronautical information](https://www.skeyes.be/en/) | Europe |
| Bolivia | Dirección General de Aeronáutica Civil | [DGAC — AIP Bolivia](https://www.dgac.gob.bo/) | South America |
| Botswana | Civil Aviation Authority of Botswana | [CAAB — AIP Botswana](https://www.caab.co.bw/) | Africa |
| Bulgaria | BULATSA | [BULATSA — AIP Bulgaria](https://www.bulatsa.com/) | Europe |
| Chile | Dirección General de Aeronáutica Civil | [DGAC — AIP Chile](https://www.dgac.gob.cl/) | South America |
| China | Civil Aviation Administration of China | [CAAC — AIP China](https://www.caac.gov.cn/) | Asia |
| Colombia | Aerocivil | [Aerocivil — AIP Colombia](https://www.aerocivil.gov.co/) | South America |
| Croatia | Croatia Control | [Croatia Control — AIP Croatia](https://www.crocontrol.hr/) | Europe |
| Czech Republic | Řízení letového provozu ČR | [ANS Czech Republic — AIS](https://aim.rlp.cz/) | Europe |
| Denmark | Naviair | [Naviair — AIP Denmark](https://www.naviair.dk/) | Europe |
| Ecuador | Dirección General de Aviación Civil | [DGAC — AIP Ecuador](https://www.aviacioncivil.gob.ec/) | South America |
| Egypt | Egyptian Civil Aviation Authority | [ECAA — AIP Egypt](https://civilaviation.gov.eg/) | Africa |
| Ethiopia | Ethiopian Civil Aviation Authority | [ECAA — AIP Ethiopia](https://www.ethiopiancaa.gov.et/) | Africa |
| Fiji | Civil Aviation Authority of Fiji | [CAAF — AIP Fiji](https://www.caaf.gov.fj/) | Oceania |
| Finland | Fintraffic ANS | [Fintraffic — AIP Finland](https://www.fintraffic.fi/en/ans) | Europe |
| Ghana | Ghana Civil Aviation Authority | [GCAA — AIP Ghana](https://www.gcaa.com.gh/) | Africa |
| Greece | Hellenic Civil Aviation Authority | [HCAA — AIP Greece](https://www.hcaa.gr/) | Europe |
| Hungary | HungaroControl | [HungaroControl — AIP Hungary](https://www.hungarocontrol.hu/) | Europe |
| Iceland | Isavia | [Isavia — AIP Iceland](https://www.isavia.is/en) | Europe |
| Indonesia | Directorate General of Civil Aviation | [DGCA Indonesia — AIP](https://hubud.dephub.go.id/) | Asia |
| Israel | Israel Airports Authority | [IAA — AIP Israel](https://www.iaa.gov.il/en/) | Middle East |
| Jordan | Civil Aviation Regulatory Commission | [CARC — AIP Jordan](https://www.carc.gov.jo/) | Middle East |
| Kenya | Kenya Civil Aviation Authority | [KCAA — AIP Kenya](https://www.kcaa.or.ke/) | Africa |
| Kuwait | Directorate General of Civil Aviation | [DGCA — AIP Kuwait](https://www.dgca.gov.kw/) | Middle East |
| Lebanon | Directorate General of Civil Aviation | [DGCA — AIP Lebanon](https://www.dgca.gov.lb/) | Middle East |
| Malaysia | Civil Aviation Authority of Malaysia | [CAAM — AIP Malaysia](https://www.caam.gov.my/) | Asia |
| Mauritius | Department of Civil Aviation | [DCA — AIP Mauritius](https://civil-aviation.govmu.org/) | Africa |
| Mexico | Agencia Federal de Aviación Civil | [AFAC — AIP México](https://www.gob.mx/afac) | North America |
| Morocco | ONDA | [ONDA — AIP Morocco](https://www.onda.ma/) | Africa |
| Namibia | Namibia Civil Aviation Authority | [NCAA — AIP Namibia](https://www.ncaa.com.na/) | Africa |
| Nepal | Civil Aviation Authority of Nepal | [CAAN — AIP Nepal](https://caanepal.gov.np/) | Asia |
| Nigeria | Nigerian Civil Aviation Authority | [NCAA — AIP Nigeria](https://ncaa.gov.ng/) | Africa |
| Oman | Civil Aviation Authority | [CAA Oman — AIP](https://www.caa.gov.om/) | Middle East |
| Pakistan | Pakistan Civil Aviation Authority | [PCAA — AIP Pakistan](https://www.caapakistan.com.pk/) | Asia |
| Papua New Guinea | Civil Aviation Safety Authority | [CASA PNG — AIP](https://www.casapng.gov.pg/) | Oceania |
| Paraguay | DINAC | [DINAC — AIP Paraguay](https://www.dinac.gov.py/) | South America |
| Peru | CORPAC | [CORPAC — AIP Peru](https://www.corpac.gob.pe/) | South America |
| Philippines | Civil Aviation Authority of the Philippines | [CAAP — AIP Philippines](https://caap.gov.ph/) | Asia |
| Portugal | NAV Portugal | [NAV Portugal — AIS](https://www.nav.pt/) | Europe |
| Qatar | Qatar Civil Aviation Authority | [QCAA — AIP Qatar](https://www.caa.gov.qa/) | Middle East |
| Romania | ROMATSA | [ROMATSA — AIP Romania](https://www.romatsa.ro/) | Europe |
| Saudi Arabia | General Authority of Civil Aviation | [GACA — AIP Saudi Arabia](https://gaca.gov.sa/) | Middle East |
| Singapore | Civil Aviation Authority of Singapore | [CAAS — AIP Singapore](https://www.caas.gov.sg/) | Asia |
| Slovakia | Letové prevádzkové služby | [LPS — AIP Slovakia](https://www.lps.sk/) | Europe |
| Slovenia | Slovenia Control | [Slovenia Control — AIP Slovenia](https://www.sloveniacontrol.si/) | Europe |
| South Korea | Korea Office of Civil Aviation | [KOCA — AIS Korea](https://www.koca.go.kr/) | Asia |
| Sri Lanka | Civil Aviation Authority of Sri Lanka | [CAASL — AIP Sri Lanka](https://www.caa.lk/) | Asia |
| Taiwan | Civil Aeronautics Administration | [CAA Taiwan — AIP](https://www.caa.gov.tw/) | Asia |
| Tanzania | Tanzania Civil Aviation Authority | [TCAA — AIP Tanzania](https://www.tcaa.go.tz/) | Africa |
| Thailand | Civil Aviation Authority of Thailand | [CAAT — AIP Thailand](https://www.caat.or.th/) | Asia |
| Tunisia | Office de l’aviation civile et des aéroports | [OACA — AIP Tunisia](https://www.oaca.nat.tn/) | Africa |
| Türkiye | DHMİ | [DHMİ — AIP Türkiye](https://www.dhmi.gov.tr/) | Europe |
| Uganda | Uganda Civil Aviation Authority | [UCAA — AIP Uganda](https://www.caa.go.ug/) | Africa |
| Ukraine | UkSATSE | [UkSATSE — AIP Ukraine](https://uksatse.ua/) | Europe |
| Uruguay | DINACIA | [DINACIA — AIP Uruguay](https://www.dinacia.gub.uy/) | South America |
| Venezuela | Instituto Nacional de Aeronáutica Civil | [INAC — AIP Venezuela](https://www.inac.gob.ve/) | South America |
| Vietnam | Civil Aviation Authority of Vietnam | [CAAV — AIP Vietnam](https://caa.gov.vn/) | Asia |
| Zambia | Zambia Airports Corporation | [ZACL — AIP Zambia](https://www.zacl.co.zm/) | Africa |
| Zimbabwe | Civil Aviation Authority of Zimbabwe | [CAAZ — AIP Zimbabwe](https://www.caaz.co.zw/) | Africa |

## Regional indexes

| Publisher | Scope | Licence | Why it is listed |
| --- | --- | --- | --- |
| [EUROCONTROL EAD Basic](https://www.ead.eurocontrol.int/) | Europe | FREE_PUBLIC | Free after registration. A consultation tool, not an app feed. |
| [EUROCONTROL — AIS Online index](https://www.eurocontrol.int/articles/ais-online) | Europe | FREE_PUBLIC | Links to each national AIS portal. |

## Coverage by region

| Region | Countries registered | Publishers |
| --- | --- | --- |
| North America | 3 | 3 |
| Europe | 27 | 27 |
| Asia | 16 | 16 |
| Middle East | 9 | 9 |
| Oceania | 4 | 4 |
| Africa | 15 | 15 |
| South America | 10 | 10 |

## Countries with no registered source

These are not hidden and not faked: the EFB reports "No source" for their
airports. Adding one is a registry edit, not a code change.

Afghanistan, Albania, Algeria, Angola, Armenia, Azerbaijan, Belarus, Bhutan,
Bosnia and Herzegovina, Brunei, Cambodia, Cameroon, Congo (DRC), Costa Rica,
Cuba, Cyprus, Estonia, Georgia, Iran, Iraq, Jamaica, Kazakhstan, Kyrgyzstan,
Laos, Latvia, Libya, Lithuania, Luxembourg, Madagascar, Maldives, Malta,
Moldova, Mongolia, Montenegro, Mozambique, Myanmar, North Korea, Panama,
Senegal, Serbia, Sudan, Syria, Trinidad and Tobago, Turkmenistan, Uzbekistan,
Yemen.

## Adding a country

1. Find the publisher's **own** portal (the AIS/AIP site, not an aggregator).
2. Read its terms. Choose the category that describes what it actually allows:
   `FREE_REUSE`, `FREE_PUBLIC`, `FREE_PERSONAL_ONLY`, `PAID`,
   `PERMISSION_REQUIRED` or `UNKNOWN`. Never choose `FREE_REUSE` without written
   terms naming third-party display and redistribution.
3. Add one record to `app/js/data/chart-sources.js`:

```js
source({
  id: 'caa-xx', country: 'Country', iso2: 'XX', region: 'Europe',
  icao: ['XX'],                   // ICAO location-indicator prefixes
  authority: 'Civil Aviation Authority',
  name: 'CAA — AIP Country',
  url: 'https://ais.example.gov/',
  licence: 'FREE_PUBLIC',
  checked: null,                  // only a date you actually verified
  note: 'What the terms say, in one sentence.',
});
```

4. Run `node scripts/chart-licensing-report.mjs` and commit the regenerated report
   with the registry change.
5. Run `npm test`. `tests/charts.test.mjs` checks every record has an https portal, a
   licence category from the list above, and no document URL.

## Adding an embedded provider

Embedding is a separate step and needs terms that permit it. Add a descriptor with
`status: 'integrated'` in `app/js/lib/chartproviders.js` plus a fetch adapter, and
keep the proxy narrow: a fixed host, a fixed path shape and a document-name pattern,
as `api/chart.js` does for the FAA. AIRAC cycles are recorded per catalogue, and a
document whose cycle has expired is labelled expired, never current.

