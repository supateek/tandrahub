"""Builds public/index.html (the live site) from the app source.
Usage: python3 build/build.py <path to tandra.html>"""
import sys, os, re
ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
src=open(sys.argv[1]).read()
live=open(os.path.join(ROOT,'build','live.js')).read()
lib=open(os.path.join(ROOT,'build','pdf-lib.min.js')).read().replace('</script','<\\/script')
s=src.replace("const LIVE=false;","const LIVE=true;",1)
m=re.search(r"\nif\(LIVE\)\{const route=.*?else render\(\);\n",s,re.S); assert m
s=s[:m.start()]+"\n"+live+"\nboot();\n"+s[m.end():]
s=s.replace("load();\n"+live,live,1)  # no-op safety
i=s.index('<div id="bar"></div>');head,body=s[:i],s[i:]
head=head.replace('<meta name="claude:viewport-fit-sides" content="cover">\n','')
fav="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='16' fill='%2313998C'/%3E%3Cpath d='M16 18h32v7H35.5v23h-7V25H16z' fill='white'/%3E%3C/svg%3E"
doc=('<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n'
 '<meta name="description" content="Tandra Asset Hub Ltd — homes in Abuja. Browse estates, apply online, sign your offer, pay and receive a QR-verified allocation letter.">\n'
 '<meta name="theme-color" content="#13998C">\n<meta property="og:title" content="Tandra Asset Hub">\n<meta property="og:description" content="Homes in Lugbe, Idu, Asokoro and Guzape. Apply online with flexible payment plans.">\n'
 f'<link rel="icon" href="{fav}">\n'
 '<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0;font:14px system-ui,sans-serif}img{max-width:100%}[hidden]{display:none!important}</style>\n'
 + head.strip()+'\n</head>\n<body>\n<script>'+lib+'</script>\n'+body+'\n</body>\n</html>\n')
os.makedirs(os.path.join(ROOT,'public'),exist_ok=True)
open(os.path.join(ROOT,'public','index.html'),'w').write(doc)
print('public/index.html',len(doc)//1024,'KB')
