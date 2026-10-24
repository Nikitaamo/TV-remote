# LG pultas

LG webOS televizoriaus pultas telefono naršyklėje. Tai statinė svetainė (HTML/CSS/JS), be serverio: telefonas jungiasi tiesiai prie televizoriaus per tą patį Wi-Fi tinklą.

Svetainė: https://nikitaamo.github.io/TV-remote/

## Ką moka

- Garsas +/−, nutildymas, kanalai +/−, kanalų sąrašas, ankstesnis kanalas, skaičiai 0–9.
- Rodyklės, OK, Atgal, Pradžia, Išeiti, TV nustatymai, paieška, įvestys (HDMI).
- Grojimas, pauzė, stop, atsukimas, prasukimas, spalvoti mygtukai, gidas, info, subtitrai.
- Greitosios nuorodos: YouTube, Netflix ir kitos TV įdiegtos programėlės (Prime Video, Disney+, Spotify, Go3, Telia Play, LRT, naršyklė). Rodomos tik tos, kurios yra televizoriuje.
- Visų įdiegtų programėlių ir įvesčių sąrašas.
- „Pelė“: jutiklinis laukas Magic Remote žymekliui ir slinkimui.
- TV išjungimas.
- Atsimena televizorių (pavadinimą, modelį, poravimo raktą) ir kitą kartą prisijungia pats.
- Galima įsidėti į telefono pradžios ekraną kaip programėlę (Chrome → ⋮ → „Įdiegti programą“ arba „Pridėti prie pradžios ekrano“).

## Pirmas paleidimas

1. Televizorius įjungtas, telefonas ir TV tame pačiame Wi-Fi.
2. Atidarykite svetainę telefone (Chrome) ir spauskite „Ieškoti TV automatiškai“. Chrome paklaus, ar leisti pasiekti vietinio tinklo įrenginius: pasirinkite „Leisti“.
3. Bakstelėkite rastą televizorių. Atsidarys skirtukas su įspėjimu „Jūsų ryšys nėra privatus“, nes TV naudoja savo pasirašytą sertifikatą. Spauskite „Išplėstiniai“ → „Tęsti į …“. Po to rodoma klaida ar tuščias puslapis yra normalu, grįžkite į pultą.
4. Pultas prisijungs pats. TV ekrane pulteliu leiskite prisijungti. Televizorius išsaugomas telefone („Mano televizoriai“), kitą kartą prisijungiama automatiškai.

Jei kitą kartą prisijungti nepavyksta, pultas pats nustato priežastį ir parodo vieną mygtuką:
- TV įjungtas, bet naršyklė pamiršo sertifikatą → „Patvirtinti“;
- TV gavo naują IP adresą → pultas jį suranda ir prašo patvirtinti sertifikatą naujam adresui (TV ekrane leisti iš naujo nereikia);
- TV išjungtas → „Bandyti“, kai jį įjungsite.

Jei paieška TV neranda, IP adresą galima įvesti ranka. Jį rasite TV: Nustatymai → Tinklas → Wi-Fi ryšys (arba Laidinis ryšys) → Išplėstiniai nustatymai.

Rekomenduojama maršrutizatoriuje TV priskirti pastovų IP adresą, kad jo nereikėtų keisti.

## Apribojimai

- **TV įjungti negalima.** Įjungimui reikia Wake-on-LAN (UDP), o naršyklė UDP siųsti negali. Išjungti galima.
- **Veikia Android telefone su Chrome.** iPhone Safari neleidžia `wss://` ryšio su savo pasirašytu TV sertifikatu, todėl iPhone greičiausiai neprisijungs.
- Naršyklė kartais pamiršta patvirtintą sertifikatą (pvz., po naujinimo). Tada pakartokite 3 žingsnį arba spauskite „Atidaryti sertifikatą“.
- Chrome (nuo 142 versijos) leidžia pasiekti vietinio tinklo įrenginius tik gavus leidimą. Jei jį atmetėte: adreso juostoje bakstelėkite piktogramą kairėje → Leidimai → „Vietinis tinklas“ → Leisti.
- Senesniuose LG televizoriuose (webOS 3–4) gali reikėti įjungti Nustatymai → Tinklas → „LG Connect Apps“.
- Svečių Wi-Fi tinkluose ir tinkluose su įjungta klientų izoliacija (AP isolation) telefonas TV nepasieks.

## Kaip veikia

Automatinė paieška: naršyklė negali naudoti SSDP/mDNS, todėl `js/discover.js` pirmiausia randa tinklą (maršrutizatorius atsako adresu `.1` arba `.254`), tada patikrina visus 254 adresus. LG televizorių atpažįsta pagal DIAL tarnybą prievade 36866 ir UPnP aprašą prievade 1754. Pavadinimą (pvz. „[LG] webOS TV …“) bando perskaityti iš UPnP aprašo; jei TV to neleidžia, rodoma „LG televizorius“, o tikslus modelis gaunamas prisijungus. Kiti įrenginiai pažymimi pagal tipą (maršrutizatorius, Samsung TV, Google TV / Chromecast).

Atmintis: kiekvienas TV saugomas pagal jo unikalų `deviceUUID` (gaunamas SSAP `hello` žinute), todėl pasikeitus IP adresui jis atpažįstamas ir naudojamas tas pats poravimo raktas.

Programėlė kalba LG SSAP protokolu per `wss://<TV IP>:3001`. LG televizorius atmeta WebSocket ryšius iš įprastų svetainių, bet priima `Origin: null`, todėl kiekvienas ryšys atidaromas paslėptame `data:` iframe ir perduodamas puslapiui per `postMessage` (`js/lgtv.js`). Mygtukai siunčiami per TV „pointer input“ socket, garsas, kanalai, programėlės ir įvestys per SSAP užklausas.

Failai:

- `index.html`, `css/style.css`: sąsaja.
- `js/lgtv.js`: LG TV klientas.
- `js/discover.js`: TV paieška tinkle ir Chrome vietinio tinklo leidimas.
- `js/app.js`: mygtukai, prisijungimas, automatinis persijungimas, jutiklinis laukas.
- `sw.js`, `manifest.webmanifest`, `icons/`: įdiegimas į pradžios ekraną ir darbas be interneto.

## Talpinimas

GitHub Pages: Settings → Pages → Source: „Deploy from a branch“, Branch: `main`, aplankas `/ (root)`.
