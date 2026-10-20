from playwright.sync_api import sync_playwright
B="http://localhost:3000"
def login(b,email):
    c=b.new_context(viewport={"width":1440,"height":900}); p=c.new_page()
    p.goto(B+"/connexion"); p.fill("input[name=login]",email); p.fill("input[name=password]","Joueur123!"); p.click("form.form button"); return p
def shot(p,url,name):
    p.goto(B+url); p.wait_for_timeout(900); p.screenshot(path=f"screenshots/{name}.png",full_page=True)
with sync_playwright() as pw:
    b=pw.chromium.launch()
    p=login(b,"neoblaze@exemple.gg"); shot(p,"/classement","sr-classement"); shot(p,"/profil","sr-profil-comptes-lies"); shot(p,"/joueurs/NeoBlaze","sr-profil-public")
    z=login(b,"zephyr@exemple.gg"); shot(z,"/matchmaking","sr-matchmaking-file")
    k=login(b,"kiravolt@exemple.gg"); shot(k,"/parties/DEMO42","sr-lobby-code")
    s=login(b,"shadowfox@exemple.gg")
    for x in (p,s):
        x.goto(B+"/matchmaking"); x.click("form[action='/matchmaking/rejoindre']:has(input[value='Call of Duty|4v4']) button") if False else x.evaluate("""async()=>{await fetch('/matchmaking/rejoindre',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'gm=Call of Duty|1v1'})}""")
    code=p.evaluate("fetch('/api/joueurs/NeoBlaze').then(r=>r.json()).then(j=>j.lobby)"); shot(p,"/parties/"+code,"sr-lobby-equipes")
    b.close()
