from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from api.routes import verify, verify_stream

app = FastAPI(title="Fact Checking API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(verify.router, prefix="/api", tags=["Verification"])
app.include_router(verify_stream.router, prefix="/api", tags=["Verification"])

@app.get("/")
async def root():
    return {"status": "online", "service": "fact-checking-backend"}

@app.get("/api/health")
async def health():
    return {"status": "healthy"}