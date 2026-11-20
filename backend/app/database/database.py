from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.config import settings


class Base(DeclarativeBase):
    pass


def _make_engine(url: str):
    if url.startswith("sqlite"):
        kwargs: dict = {"connect_args": {"check_same_thread": False}}
        if url in ("sqlite://", "sqlite:///:memory:"):
            kwargs["poolclass"] = StaticPool  # one shared in-memory DB (used by tests)
        return create_engine(url, **kwargs)
    return create_engine(url, pool_pre_ping=True)


engine = _make_engine(settings.sqlalchemy_url)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def init_db() -> None:
    from app import models  # noqa: F401  (registers the tables)

    Base.metadata.create_all(bind=engine)
    try:
        with engine.connect() as conn:
            from sqlalchemy import text
            cols = [row[1] for row in conn.execute(text("PRAGMA table_info(participants)")).fetchall()]
            if cols and "last_seen" not in cols:
                conn.execute(text("ALTER TABLE participants ADD COLUMN last_seen DATETIME"))
                conn.commit()
            if cols and "left_at" not in cols:
                conn.execute(text("ALTER TABLE participants ADD COLUMN left_at DATETIME"))
                conn.commit()
            chat_cols = [row[1] for row in conn.execute(text("PRAGMA table_info(chat_messages)")).fetchall()]
            if chat_cols and "mentions" not in chat_cols:
                conn.execute(text("ALTER TABLE chat_messages ADD COLUMN mentions JSON"))
                conn.commit()
    except Exception:
        pass


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
