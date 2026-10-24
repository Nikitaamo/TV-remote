# LG pultas

LG webOS televizoriaus pultas telefono naršyklėje. Tai statinė svetainė (HTML/CSS/JS), be serverio: telefonas jungiasi tiesiai prie televizoriaus per tą patį Wi-Fi tinklą.

Svetainė: https://nikitaamo.github.io/tv-remote/

## Ką moka

- Garsas +/−, nutildymas, kanalai +/−, kanalų sąrašas, ankstesnis kanalas, skaičiai 0–9.
- Rodyklės, OK, Atgal, Pradžia, Išeiti, TV nustatymai, paieška, įvestys (HDMI).
- Grojimas, pauzė, stop, atsukimas, prasukimas, spalvoti mygtukai, gidas, info, subtitrai.
- Greitosios nuorodos: YouTube, Netflix ir kitos TV įdiegtos programėlės (Prime Video, Disney+, Spotify, Go3, Telia Play, LRT, naršyklė). Rodomos tik tos, kurios yra televizoriuje.
- Visų įdiegtų programėlių ir įvesčių sąrašas.
- „Pelė“: jutiklinis laukas Magic Remote žymekliui ir slinkimui.
- TV išjungimas.
- Galima įsidėti į telefono pradžios ekraną kaip programėlę (Chrome → ⋮ → „Įdiegti programą“ arba „Pridėti prie pradžios ekrano“).

## Pirmas paleidimas

1. Televizorius įjungtas, telefonas ir TV tame pačiame Wi-Fi.
2. Sužinokite TV IP adresą: Nustatymai → Tinklas → Wi-Fi ryšys (arba Laidinis ryšys) → Išplėstiniai nustatymai.
3. Atidarykite svetainę telefone, įveskite IP.
4. Spauskite „Atidaryti sertifikatą“. Naršyklė parodys įspėjimą „Jūsų ryšys nėra privatus“, nes TV naudoja savo pasirašytą sertifikatą. Spauskite „Išplėstiniai“ → „Tęsti į …“. Po to rodoma klaida ar tuščias puslapis yra normalu, grįžkite į pultą.
5. Spauskite „Prisijungti“ ir TV ekrane pulteliu leiskite prisijungti. Raktas išsaugomas telefone, kitą kartą prisijungiama automatiškai.

Rekomenduojama maršrutizatoriuje TV priskirti pastovų IP adresą, kad jo nereikėtų keisti.

## Apribojimai

- **TV įjungti negalima.** Įjungimui reikia Wake-on-LAN (UDP), o naršyklė UDP siųsti negali. Išjungti galima.
- **Veikia Android telefone su Chrome.** iPhone Safari neleidžia `wss://` ryšio su savo pasirašytu TV sertifikatu, todėl iPhone greičiausiai neprisijungs.
- Naršyklė kartais pamiršta patvirtintą sertifikatą (pvz., po naujinimo). Tada pakartokite 4 žingsnį.
- Naujesnė Chrome versija gali paklausti leidimo pasiekti vietinio tinklo įrenginius. Jį reikia leisti.
- Senesniuose LG televizoriuose (webOS 3–4) gali reikėti įjungti Nustatymai → Tinklas → „LG Connect Apps“.
- Svečių Wi-Fi tinkluose ir tinkluose su įjungta klientų izoliacija (AP isolation) telefonas TV nepasieks.

## Kaip veikia

Programėlė kalba LG SSAP protokolu per `wss://<TV IP>:3001`. LG televizorius atmeta WebSocket ryšius iš įprastų svetainių, bet priima `Origin: null`, todėl kiekvienas ryšys atidaromas paslėptame `data:` iframe ir perduodamas puslapiui per `postMessage` (`js/lgtv.js`). Mygtukai siunčiami per TV „pointer input“ socket, garsas, kanalai, programėlės ir įvestys per SSAP užklausas.

Failai:

- `index.html`, `css/style.css`: sąsaja.
- `js/lgtv.js`: LG TV klientas.
- `js/app.js`: mygtukai, prisijungimas, automatinis persijungimas, jutiklinis laukas.
- `sw.js`, `manifest.webmanifest`, `icons/`: įdiegimas į pradžios ekraną ir darbas be interneto.

## Talpinimas

GitHub Pages: Settings → Pages → Source: „Deploy from a branch“, Branch: `main`, aplankas `/ (root)`.
